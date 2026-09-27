import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT_DIR = resolve(import.meta.dir, "..");
const GOLDEN_DIR = resolve(import.meta.dir, "golden");
const FIXTURE_BIN_DIR = resolve(import.meta.dir, "fixtures/bin");
const FIXTURE_YT_DLP = resolve(FIXTURE_BIN_DIR, "yt-dlp");
const FIXTURE_WHISPER_CLI = resolve(FIXTURE_BIN_DIR, "whisper-cli");
const FIXTURE_FFMPEG = resolve(FIXTURE_BIN_DIR, "ffmpeg");
const FIXTURE_MODEL = resolve(FIXTURE_BIN_DIR, "fixture-model.bin");
const BASE_URL = "https://www.youtube.com/watch?v=";

let tempDir = "";

beforeAll(async () => {
  tempDir = await mkdtemp(resolve(tmpdir(), "yt-converter-golden-"));
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function stableJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function goldenEnvironment<T extends Record<string, string | undefined>>(
  environment: T,
) {
  // Pin color alongside the path and timestamp normalizations below so fixture
  // bytes do not depend on ambient TTY or color-forcing environment variables.
  const normalized = {
    ...environment,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  delete normalized.CLICOLOR_FORCE;
  return normalized;
}

async function assertGolden(name: string, actual: string): Promise<void> {
  const path = resolve(GOLDEN_DIR, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(GOLDEN_DIR, { recursive: true });
    await Bun.write(path, actual);
  }

  expect(await Bun.file(path).text()).toBe(actual);
}

async function runCli(url: string, outputDir: string) {
  const child = Bun.spawn([
    process.execPath,
    "src/cli.ts",
    "transcript",
    url,
  ], {
    cwd: ROOT_DIR,
    env: goldenEnvironment({
      ...process.env,
      CLIENT_DOWNLOAD_DIR: outputDir,
      YT_DLP_PATH: FIXTURE_YT_DLP,
      WHISPER_CLI_PATH: FIXTURE_WHISPER_CLI,
      FFMPEG_PATH: FIXTURE_FFMPEG,
      WHISPER_MODEL_PATH: FIXTURE_MODEL,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // The CLI prints an absolute user-selected output path. It is the only
  // nondeterministic field here, so preserve the filename and replace only
  // the temporary parent directory used by this test.
  return {
    stdout: stdout.split(outputDir).join("<OUTPUT_DIR>"),
    stderr: stderr.split(outputDir).join("<OUTPUT_DIR>"),
    exitCode,
  };
}

async function captureCli(): Promise<void> {
  const captionsDir = resolve(tempDir, "cli");
  await mkdir(captionsDir, { recursive: true });
  const captionsSuccess = await runCli(`${BASE_URL}fixture12345`, captionsDir);

  await assertGolden("cli-transcript.stdout.txt", captionsSuccess.stdout);
  await assertGolden("cli-transcript-result.json", stableJson(captionsSuccess));
  await assertGolden(
    "cli-transcript-file.txt",
    await Bun.file(resolve(captionsDir, "Fixture_Video_E2E_Test.txt")).text(),
  );

  const sttDir = resolve(tempDir, "cli-stt");
  await mkdir(sttDir, { recursive: true });
  const sttSuccess = await runCli(`${BASE_URL}no-captions`, sttDir);

  await assertGolden("cli-transcript-stt.stdout.txt", sttSuccess.stdout);
  await assertGolden("cli-transcript-stt-result.json", stableJson(sttSuccess));
  await assertGolden(
    "cli-transcript-stt-file.txt",
    await Bun.file(resolve(sttDir, "Fixture_Video_E2E_Test.txt")).text(),
  );

  const failures = [];
  for (const [scenario, url] of [
    ["invalid_source", "not-a-real-source"],
    ["downloader_failure", `${BASE_URL}downloader-failure`],
  ] as const) {
    failures.push({ scenario, ...await runCli(url, resolve(tempDir, `cli-errors-${scenario}`)) });
  }
  await assertGolden("cli-errors.json", stableJson(failures));
}

async function captureMcp(): Promise<void> {
  const cacheDir = resolve(tempDir, "mcp-cache");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve(ROOT_DIR, "src/mcp.ts")],
    env: goldenEnvironment({
      ...getDefaultEnvironment(),
      MCP_TRANSCRIPT_DIR: cacheDir,
      YT_DLP_PATH: FIXTURE_YT_DLP,
      WHISPER_CLI_PATH: FIXTURE_WHISPER_CLI,
      FFMPEG_PATH: FIXTURE_FFMPEG,
      WHISPER_MODEL_PATH: FIXTURE_MODEL,
    }),
    stderr: "pipe",
  });
  const client = new Client({ name: "golden-test", version: "1.0.0" });

  try {
    await client.connect(transport);
    const results = {
      videoInfoSuccess: await client.callTool({
        name: "get_youtube_video_info",
        arguments: { url: `${BASE_URL}fixture12345` },
      }),
      videoInfoError: await client.callTool({
        name: "get_youtube_video_info",
        arguments: { url: `${BASE_URL}downloader-failure` },
      }),
      transcriptSuccess: await client.callTool({
        name: "get_youtube_transcript",
        arguments: { url: `${BASE_URL}fixture12345`, includeMetadata: true },
      }),
      transcriptError: await client.callTool({
        name: "get_youtube_transcript",
        arguments: { url: `${BASE_URL}no-captions`, includeMetadata: false },
      }),
      videoTranscriptStt: await client.callTool({
        name: "get_video_transcript",
        arguments: { url: "https://vimeo.com/no-captions-123", includeMetadata: true },
      }),
    };

    // Transcript metadata exposes both the configured cache root and a random
    // mkdtemp child. Normalize those two path components and nothing else.
    const normalized = stableJson(results)
      .split(cacheDir).join("<CACHE_DIR>")
      .replace(/transcript-[A-Za-z0-9_-]+/g, "<CALL_DIR>");
    await assertGolden("mcp-results.json", normalized);
  } finally {
    await client.close();
  }
}

async function captureHttp(): Promise<void> {
  const downloadDir = resolve(tempDir, "http-downloads");
  await mkdir(downloadDir, { recursive: true });
  const captureScript = `
    const { createApplication } = await import("./src/index.ts");
    const runtime = await createApplication();
    const app = runtime.app;
    console.log = () => {};
    const convertResponse = await app.request("/api/convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: process.env.GOLDEN_URL, format: "transcript" }),
    });
    const convertBody = await convertResponse.json();
    let jobResponse;
    let jobBody;
    for (let attempt = 0; attempt < 100; attempt++) {
      jobResponse = await app.request(\`/api/jobs/\${convertBody.jobId}\`);
      jobBody = await jobResponse.json();
      if (!["queued", "processing"].includes(jobBody.status)) break;
      await Bun.sleep(10);
    }
    if (!jobResponse || !jobBody || ["queued", "processing"].includes(jobBody.status)) {
      throw new Error("Golden transcript job did not complete");
    }
    const downloadResponse = await app.request(\`/downloads/\${convertBody.jobId}\`);
    const captured = {
      convert: { status: convertResponse.status, body: convertBody },
      job: { status: jobResponse.status, body: jobBody },
      download: {
        status: downloadResponse.status,
        contentType: downloadResponse.headers.get("content-type"),
        contentDisposition: downloadResponse.headers.get("content-disposition"),
        body: await downloadResponse.text(),
      },
    };
    await runtime.close();
    process.stdout.write("__GOLDEN_HTTP__" + JSON.stringify(captured, null, 2) + "\\n");
  `;
  const child = Bun.spawn([process.execPath, "--eval", captureScript], {
    cwd: ROOT_DIR,
    env: goldenEnvironment({
      ...process.env,
      DOWNLOAD_DIR: downloadDir,
      GOLDEN_URL: `${BASE_URL}fixture12345`,
      YT_DLP_PATH: FIXTURE_YT_DLP,
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`Golden HTTP capture failed:\n${stderr}`);
  }

  const payload = stdout.slice(stdout.lastIndexOf("__GOLDEN_HTTP__") + "__GOLDEN_HTTP__".length);
  const captured = JSON.parse(payload) as { convert: { body: { jobId: string } } };
  const jobId = captured.convert.body.jobId;
  // Job IDs contain a timestamp and random UUID suffix; completed jobs also
  // expose timestamps and an absolute server download path. Replace exactly
  // those fields while retaining all response keys and path suffixes.
  const normalized = payload
    .split(downloadDir).join("<DOWNLOAD_DIR>")
    .split(jobId).join("<JOB_ID>")
    .replace(/"(createdAt|queuedAt|startedAt|finishedAt|expiresAt)": \d+/g, '"$1": "<TIMESTAMP>"');
  await assertGolden("http-convert-job.json", normalized);
}

describe("TypeScript behavior golden fixtures", () => {
  test("match the CLI, MCP, and HTTP surfaces", async () => {
    await captureCli();
    await captureMcp();
    await captureHttp();
  }, 20_000);
});
