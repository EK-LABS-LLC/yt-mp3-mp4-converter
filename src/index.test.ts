import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { JobStore } from "./jobs";

const fixtureDir = resolve(import.meta.dir, "../test/fixtures/bin");
let runtime: Awaited<ReturnType<typeof import("./index").createApplication>>;
let app: typeof runtime.app;
let uploadDir: string;
let downloadDir: string;
const addedEnv = ["YT_DLP_PATH", "DEMUCS_PATH"] as const;
const originalEnv: Record<string, string | undefined> = {};
const videoUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

beforeAll(async () => {
  uploadDir = await mkdtemp("/tmp/converter-upload-test-");
  downloadDir = await mkdtemp("/tmp/converter-download-test-");
  process.env.UPLOAD_DIR = uploadDir;
  process.env.DOWNLOAD_DIR = downloadDir;
  process.env.FFMPEG_PATH = resolve(fixtureDir, "ffmpeg");
  process.env.WHISPER_CLI_PATH = resolve(fixtureDir, "whisper-cli");
  process.env.WHISPER_MODEL_PATH = resolve(fixtureDir, "fixture-model.bin");
  for (const key of addedEnv) originalEnv[key] = process.env[key];
  process.env.YT_DLP_PATH = resolve(fixtureDir, "yt-dlp");
  process.env.DEMUCS_PATH = resolve(fixtureDir, "demucs");
  const { createApplication } = await import("./index");
  runtime = await createApplication({ downloadDir, uploadDir });
  app = runtime.app;
});

afterAll(async () => {
  await runtime.close();
  await rm(uploadDir, { recursive: true, force: true });
  await rm(downloadDir, { recursive: true, force: true });
  for (const key of addedEnv) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

type Runtime = typeof runtime;
const isolated: Array<{ runtime?: Runtime; dir: string }> = [];

afterEach(async () => {
  for (const entry of isolated.splice(0)) {
    await entry.runtime?.close(1);
    await rm(entry.dir, { recursive: true, force: true });
  }
});

async function isolatedRuntime(overrides: Partial<Runtime["config"]> = {}, dir?: string) {
  const root = dir ?? await mkdtemp("/tmp/converter-isolated-test-");
  const { createApplication } = await import("./index");
  const created = await createApplication({ downloadDir: root, uploadDir: join(root, ".uploads"), minFreeDiskBytes: 0, ...overrides });
  const entry = isolated.find(item => item.dir === root);
  if (entry) entry.runtime = created;
  else isolated.push({ runtime: created, dir: root });
  return created;
}

async function isolatedDir() {
  const dir = await mkdtemp("/tmp/converter-isolated-test-");
  isolated.push({ dir });
  return dir;
}

const post = (target: Runtime, body: string) => target.app.fetch(new Request("http://localhost/api/convert", { method: "POST", body, headers: { "Content-Type": "application/json" } }));

async function finished(target: Runtime, jobId: string) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await (await target.app.fetch(new Request(`http://localhost/api/jobs/${jobId}`))).json() as { status: string; error?: string; filename?: string };
    if (!["queued", "processing"].includes(job.status)) return job;
    await Bun.sleep(10);
  }
  throw new Error(`job ${jobId} did not finish`);
}

describe("browser transcription upload", () => {
  test("accepts a raw media upload and returns the shared polling contract", async () => {
    const response = await app.fetch(new Request("http://localhost/api/transcribe", { method: "POST", body: "fixture media", headers: { "Content-Type": "application/octet-stream", "X-Upload-Filename": "lecture.mp4" } }));
    expect(response.status).toBe(202);
    const started = await response.json() as { jobId: string; status: string };
    expect(started.status).toBe("queued");

    let job: { status: string; filename?: string } = { status: "processing" };
    for (let attempt = 0; attempt < 30; attempt++) {
      await Bun.sleep(10);
      job = await (await app.fetch(new Request(`http://localhost/api/jobs/${started.jobId}`))).json() as typeof job;
      if (!["queued", "processing"].includes(job.status)) break;
    }
    expect(job.status).toBe("completed");
    const download = await app.fetch(new Request(`http://localhost/downloads/${started.jobId}`));
    expect(await download.text()).toContain("local speech-to-text fixture transcript");
    expect(await readdir(uploadDir)).toHaveLength(0);
  });

  test("rejects empty and non-media uploads", async () => {
    for (const file of [new File([], "empty.mp4", { type: "video/mp4" }), new File(["x"], "notes.txt", { type: "text/plain" })]) {
      const response = await app.fetch(new Request("http://localhost/api/transcribe", { method: "POST", body: file, headers: { "Content-Type": "application/octet-stream", "X-Upload-Filename": encodeURIComponent(file.name) } }));
      expect([400, 415]).toContain(response.status);
    }
  });
});

describe("URL conversion", () => {
  test.each([
    ["mp3", "audio/mpeg", "Fixture Video_ E2E Test.mp3"],
    ["mp4", "video/mp4", "Fixture Video_ E2E Test.mp4"],
    ["transcript", "text/plain; charset=utf-8", "Fixture Video_ E2E Test.txt"],
    ["instrumental", "audio/wav", "Fixture Video_ E2E Test_instrumental.wav"],
  ])("converts a video URL to %s and serves the result", async (format, contentType) => {
    const response = await post(runtime, JSON.stringify({ url: videoUrl, format }));
    expect(response.status).toBe(202);
    const started = await response.json() as { jobId: string; checkUrl: string; message: string };
    expect(started.message).toBe("Conversion queued");
    expect(started.checkUrl).toBe(`/api/jobs/${started.jobId}`);

    const job = await finished(runtime, started.jobId);
    expect(job).toMatchObject({ status: "completed" });
    const download = await app.fetch(new Request(`http://localhost/downloads/${started.jobId}`));
    expect(download.status).toBe(200);
    expect(download.headers.get("Content-Type")).toBe(contentType);
    expect(download.headers.get("Content-Disposition")).toContain(`filename="${job.filename}"`);
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  test("removes the downloaded source after producing an instrumental", async () => {
    const response = await post(runtime, JSON.stringify({ url: videoUrl, format: "instrumental" }));
    const { jobId } = await response.json() as { jobId: string };
    await finished(runtime, jobId);
    expect((await readdir(join(downloadDir, ".jobs", jobId))).sort()).toEqual(["result.wav"]);
  });

  test("rejects malformed JSON and invalid requests", async () => {
    const malformed = await post(runtime, "{not json");
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_JSON" });

    const invalid = await post(runtime, JSON.stringify({ url: "not a url", format: "mp3" }));
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: "VALIDATION_ERROR" });
  });

  test("refuses work when free disk space is below the configured floor", async () => {
    const target = await isolatedRuntime({ minFreeDiskBytes: Number.MAX_SAFE_INTEGER });
    const response = await post(target, JSON.stringify({ url: videoUrl, format: "mp3" }));
    expect(response.status).toBe(507);
    expect(await response.json()).toMatchObject({ code: "INSUFFICIENT_STORAGE" });
    expect(target.store.allJobs()).toHaveLength(0);
  });

  test("refuses work when free disk space cannot be verified", async () => {
    const stateDir = await isolatedDir();
    const target = await isolatedRuntime({ stateDir });
    await rm(target.config.downloadDir, { recursive: true, force: true });
    const response = await post(target, JSON.stringify({ url: videoUrl, format: "mp3" }));
    expect(response.status).toBe(507);
    expect(await response.json()).toMatchObject({ error: "Cannot verify free disk space" });
  });

  test("fails closed when job storage breaks", async () => {
    const target = await isolatedRuntime();
    target.store.close();
    const broken = await post(target, JSON.stringify({ url: videoUrl, format: "mp3" }));
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ code: "INTERNAL_ERROR" });

    const after = await post(target, JSON.stringify({ url: videoUrl, format: "mp3" }));
    expect(after.status).toBe(503);
    expect(after.headers.get("Retry-After")).toBe("5");
    expect(await after.json()).toMatchObject({ code: "STORAGE_UNAVAILABLE" });

    const health = await target.app.fetch(new Request("http://localhost/health"));
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ status: "unhealthy", error: "Job storage is unavailable" });
  });

  test("rejects new work while draining", async () => {
    const target = await isolatedRuntime();
    target.beginDrain();
    const response = await post(target, JSON.stringify({ url: videoUrl, format: "mp3" }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "SHUTTING_DOWN" });
  });
});

describe("health", () => {
  test("reports healthy when every tool and the model are available", async () => {
    const response = await app.fetch(new Request("http://localhost/health"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "healthy", draining: false, storageCheckAvailable: true,
      ytDlp: { installed: true, version: "fixture-yt-dlp-1.0.0" },
      ffmpeg: { installed: true, version: "ffmpeg version fixture-1.0.0" },
      whisper: { installed: true, model: true },
    });
  });

  test("reports unhealthy when the model is missing or the server is draining", async () => {
    const target = await isolatedRuntime();
    const previous = process.env.WHISPER_MODEL_PATH;
    process.env.WHISPER_MODEL_PATH = "/tmp/converter-missing-model.bin";
    try {
      const response = await target.app.fetch(new Request("http://localhost/health"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "unhealthy", whisper: { installed: true, model: false } });
    } finally { process.env.WHISPER_MODEL_PATH = previous; }

    target.beginDrain();
    const draining = await target.app.fetch(new Request("http://localhost/health"));
    expect(draining.status).toBe(503);
    expect(await draining.json()).toMatchObject({ status: "unhealthy", draining: true });
  });

  test("reports unhealthy when a tool cannot be started", async () => {
    const previous = process.env.WHISPER_CLI_PATH;
    process.env.WHISPER_CLI_PATH = "/tmp/converter-missing-whisper-cli";
    try {
      const response = await app.fetch(new Request("http://localhost/health"));
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ status: "unhealthy", error: "A required transcription tool is unavailable" });
    } finally { process.env.WHISPER_CLI_PATH = previous; }
  });
});

describe("startup recovery and cleanup", () => {
  const ids = {
    missingSource: "00000000-0000-4000-8000-000000000001",
    interrupted: "00000000-0000-4000-8000-000000000002",
    staleReservation: "00000000-0000-4000-8000-000000000003",
    orphanFile: "00000000-0000-4000-8000-000000000004",
    orphanWork: "00000000-0000-4000-8000-000000000005",
    expired: "00000000-0000-4000-8000-000000000006",
    retainedSource: "00000000-0000-4000-8000-000000000007",
    unownedSource: "00000000-0000-4000-8000-000000000008",
  };

  test("reconciles persisted state with the filesystem on startup", async () => {
    const dir = await isolatedDir();
    const uploads = join(dir, ".uploads");
    const work = join(dir, ".jobs");
    await mkdir(uploads, { recursive: true });
    await mkdir(join(work, ids.orphanWork), { recursive: true });
    await mkdir(join(work, ids.expired), { recursive: true });
    await writeFile(join(work, ids.expired, "result.mp3"), "old output");
    await writeFile(join(uploads, `${ids.orphanFile}.part`), "orphan");
    await writeFile(join(uploads, `${ids.orphanFile}.source`), "orphan");
    await writeFile(join(uploads, `${ids.staleReservation}.part`), "partial");
    await writeFile(join(uploads, `${ids.retainedSource}.source`), "retained");
    const unownedSource = join(dir, "elsewhere.source");
    await writeFile(unownedSource, "not ours");

    const store = await JobStore.open({ stateDir: join(dir, ".state"), maxQueueSize: 10, maxPendingUploadBytes: 1000, jobTtlSeconds: 60 });
    store.enqueueUrl({ id: ids.expired, kind: "url", format: "mp3", url: videoUrl });
    store.complete(store.claimNext()!.id, { outputPath: join(work, ids.expired, "result.mp3"), filename: "old.mp3", sourceReleased: true, now: Date.now() - 120_000 });
    for (const [id, sourcePath] of [[ids.retainedSource, join(uploads, `${ids.retainedSource}.source`)], [ids.unownedSource, unownedSource]] as const) {
      store.reserveUpload({ id, reservedBytes: 10, partialPath: join(uploads, `${id}.part`), createdAt: 1 });
      store.enqueueUpload({ id, kind: "upload", format: "mp3", sourcePath, sourceBytes: 5 }, id);
      store.fail(store.claimNext()!.id, { error: "boom", errorCode: "FAILED", sourceReleased: false });
    }
    store.enqueueUrl({ id: ids.interrupted, kind: "url", format: "mp3", url: videoUrl });
    store.claimNext();
    store.reserveUpload({ id: ids.missingSource, reservedBytes: 10, partialPath: join(uploads, `${ids.missingSource}.part`), createdAt: 1 });
    store.enqueueUpload({ id: ids.missingSource, kind: "upload", format: "transcript", sourcePath: join(uploads, `${ids.missingSource}.source`), sourceBytes: 5 }, ids.missingSource);
    store.reserveUpload({ id: ids.staleReservation, reservedBytes: 10, partialPath: join(uploads, `${ids.staleReservation}.part`), createdAt: 2 });
    store.close();

    const target = await isolatedRuntime({}, dir);
    const job = async (id: string) => (await target.app.fetch(new Request(`http://localhost/api/jobs/${id}`)));

    expect(await (await job(ids.interrupted)).json()).toMatchObject({ status: "failed", errorCode: "PROCESS_INTERRUPTED" });
    expect(await (await job(ids.missingSource)).json()).toMatchObject({ status: "failed", errorCode: "SOURCE_MISSING" });
    expect((await job(ids.expired)).status).toBe(404);
    expect(target.store.get(ids.expired)).toBeUndefined();
    expect(target.store.reservations()).toEqual([]);
    expect(target.store.get(ids.retainedSource)?.sourcePath).toBeUndefined();
    expect(target.store.get(ids.unownedSource)?.sourcePath).toBe(unownedSource);
    expect(await Bun.file(unownedSource).exists()).toBe(true);
    expect(await readdir(uploads)).toEqual([]);
    expect(await readdir(work)).toEqual([]);
  });

  test("releases abandoned upload reservations during periodic cleanup", async () => {
    const target = await isolatedRuntime({ cleanupIntervalSeconds: 1 });
    const id = ids.staleReservation;
    const partial = join(target.config.uploadDir, `${id}.part`);
    await writeFile(partial, "partial");
    target.store.reserveUpload({ id, reservedBytes: 10, partialPath: partial, createdAt: Date.now() });

    const deadline = Date.now() + 3000;
    while (target.store.reservations().length > 0 && Date.now() < deadline) await Bun.sleep(20);

    expect(target.store.reservations()).toEqual([]);
    expect(await Bun.file(partial).exists()).toBe(false);
  });
});

describe("server", () => {
  test("serves the application over HTTP", async () => {
    const dir = await isolatedDir();
    const { startServer } = await import("./index");
    const started = await startServer({ downloadDir: dir, uploadDir: join(dir, ".uploads"), minFreeDiskBytes: 0, port: 0 });
    try {
      const response = await fetch(new URL("/health", started.server.url));
      expect(response.status).toBe(200);
    } finally {
      started.server.stop(true);
      await started.close(1);
    }
  });
});
