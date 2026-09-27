import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, resolve } from "node:path";

const ROOT_DIR = resolve(import.meta.dir, "..");
const FIXTURE_BIN_DIR = resolve(import.meta.dir, "fixtures/bin");
const FIXTURE_YT_DLP = resolve(FIXTURE_BIN_DIR, "yt-dlp");
const BASE_URL = "https://www.youtube.com/watch?v=";
const PORT = 20_000 + Math.floor(Math.random() * 20_000);
const ORIGIN = `http://127.0.0.1:${PORT}`;

let server: ReturnType<typeof Bun.spawn>;
let outputDir = "";
let stdoutPromise: Promise<string>;
let stderrPromise: Promise<string>;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const response = await fetch(`${ORIGIN}/health`);
      if (response.ok) return;
    } catch {
      // The server may still be starting.
    }
    await Bun.sleep(20);
  }

  server.kill();
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
  throw new Error(`Server did not start.\nstdout:\n${stdout}\nstderr:\n${stderr}`);
}

async function createJob(format: "mp3" | "mp4" | "transcript", videoId = "fixture12345") {
  const response = await fetch(`${ORIGIN}/api/convert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${BASE_URL}${videoId}`,
      format,
    }),
  });

  expect(response.status).toBe(202);
  return response.json() as Promise<{ jobId: string; checkUrl: string; pollTimeoutSeconds: number }>;
}

async function waitForJob(jobId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(`${ORIGIN}/api/jobs/${jobId}`);
    expect(response.ok).toBe(true);
    const job = await response.json() as {
      status: "processing" | "completed" | "failed";
      format: string;
      filename?: string;
      errorCode?: string;
      videoInfo?: { title: string };
    };
    if (!["queued", "processing"].includes(job.status)) return job;
    await Bun.sleep(10);
  }
  throw new Error(`Job ${jobId} did not complete`);
}

beforeAll(async () => {
  outputDir = await mkdtemp(resolve(tmpdir(), "yt-converter-api-e2e-"));
  server = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      PATH: `${FIXTURE_BIN_DIR}${delimiter}${process.env.PATH || ""}`,
      YT_DLP_PATH: FIXTURE_YT_DLP,
      WHISPER_CLI_PATH: resolve(FIXTURE_BIN_DIR, "whisper-cli"),
      FFMPEG_PATH: resolve(FIXTURE_BIN_DIR, "ffmpeg"),
      WHISPER_MODEL_PATH: resolve(FIXTURE_BIN_DIR, "fixture-model.bin"),
      PORT: String(PORT),
      DOWNLOAD_DIR: outputDir,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  stdoutPromise = new Response(server.stdout as ReadableStream<Uint8Array>).text();
  stderrPromise = new Response(server.stderr as ReadableStream<Uint8Array>).text();
  await waitForServer();
});

afterAll(async () => {
  server.kill();
  await server.exited;
  await Promise.all([stdoutPromise, stderrPromise]);
  await rm(outputDir, { recursive: true, force: true });
});

describe("web API end to end", () => {
  test("serves the frontend and dependency health", async () => {
    const [page, script, health] = await Promise.all([
      fetch(`${ORIGIN}/`),
      fetch(`${ORIGIN}/app.js`),
      fetch(`${ORIGIN}/health`),
    ]);

    expect(await page.text()).toContain("Your video. In words.");
    expect(script.headers.get("content-type")).toContain("application/javascript");
    expect(await health.json()).toMatchObject({
      status: "healthy",
      ytDlp: { installed: true, version: "fixture-yt-dlp-1.0.0" },
      ffmpeg: { installed: true },
    });
  });

  test("runs a transcript job through polling and file download", async () => {
    const { jobId, checkUrl } = await createJob("transcript");
    expect(checkUrl).toBe(`/api/jobs/${jobId}`);

    const job = await waitForJob(jobId);
    expect(job).toMatchObject({
      status: "completed",
      format: "transcript",
      filename: "Fixture_Video_E2E_Test.txt",
      videoInfo: { title: "Fixture Video: E2E Test" },
    });

    const download = await fetch(`${ORIGIN}/downloads/${jobId}`);
    expect(download.headers.get("content-type")).toContain("text/plain");
    expect(download.headers.get("content-disposition")).toContain("Fixture_Video_E2E_Test.txt");
    expect(await download.text()).toContain("shared download path works");
  });

  test("runs a transcript job that falls back to speech-to-text", async () => {
    const { jobId } = await createJob("transcript", "no-captions");
    expect(await waitForJob(jobId)).toMatchObject({
      status: "completed",
      format: "transcript",
    });

    const download = await fetch(`${ORIGIN}/downloads/${jobId}`);
    expect(await download.text()).toContain("No captions were needed");
  });

  test.each([
    ["mp3", "audio/mpeg", "ID3"],
    ["mp4", "video/mp4", "ftyp"],
  ] as const)("runs a %s job and serves the expected media type", async (format, contentType, marker) => {
    const { jobId } = await createJob(format);
    expect(await waitForJob(jobId)).toMatchObject({ status: "completed", format });

    const download = await fetch(`${ORIGIN}/downloads/${jobId}`);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(download.headers.get("content-type")).toBe(contentType);
    expect(new TextDecoder().decode(bytes)).toContain(marker);
  });

  test("advertises a poll deadline that outlasts each format's own budget", async () => {
    const [mp3, mp4, transcript] = await Promise.all([
      createJob("mp3"),
      createJob("mp4"),
      createJob("transcript"),
    ]);

    expect(mp3.pollTimeoutSeconds).toBe(360);
    expect(mp4.pollTimeoutSeconds).toBe(960);
    expect(transcript.pollTimeoutSeconds).toBe(7260);
  });

  test("returns validation, missing-job, incomplete-job, and conversion errors", async () => {
    const invalid = await fetch(`${ORIGIN}/api/convert`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "not a source", format: "transcript" }),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });

    expect((await fetch(`${ORIGIN}/api/jobs/not-found`)).status).toBe(404);
    expect((await fetch(`${ORIGIN}/api/jobs/bad%2Fjob`)).status).toBe(400);

    const { jobId } = await createJob("transcript", "private-video");
    expect((await fetch(`${ORIGIN}/downloads/${jobId}`)).status).toBe(400);
    expect(await waitForJob(jobId)).toMatchObject({
      status: "failed",
      errorCode: "VIDEO_NOT_ACCESSIBLE",
    });
  });
});
