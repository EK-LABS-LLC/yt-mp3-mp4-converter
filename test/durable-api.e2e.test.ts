import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { request as httpRequest } from "node:http";
import { Database } from "bun:sqlite";

const root = resolve(import.meta.dir, "..");
const fixture = join(root, "test/fixtures/bin");
const directories: string[] = [];
const children: Array<ReturnType<typeof Bun.spawn>> = [];
const body = new Uint8Array([1, 2, 3, 4]);
const headers = { "Content-Type": "application/octet-stream", "X-Upload-Filename": "meeting.mp4" };

async function eventually<T>(action: () => Promise<T>, predicate: (value: T) => boolean, timeout = 5000): Promise<T> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await action();
    if (predicate(value)) return value;
    await Bun.sleep(20);
  }
  throw new Error("Condition did not become true");
}

async function start(directory?: string, extra: Record<string, string> = {}) {
  const dir = directory || await mkdtemp(join(tmpdir(), "transcriber-durable-"));
  if (!directories.includes(dir)) directories.push(dir);
  const port = 25000 + Math.floor(Math.random() * 25000);
  const origin = `http://127.0.0.1:${port}`;
  const child = Bun.spawn([process.execPath, "src/index.ts"], {
    cwd: root,
    env: { ...process.env, PATH: `${fixture}${delimiter}${process.env.PATH || ""}`, PORT: String(port), DOWNLOAD_DIR: dir, STATE_DIR: join(dir, ".state"), UPLOAD_DIR: join(dir, ".uploads"), MAX_FILE_SIZE_MB: "1", MAX_PENDING_UPLOAD_BYTES: String(4 * 1024 * 1024), MIN_FREE_DISK_BYTES: "0", MAX_QUEUE_SIZE: "10", JOB_CONCURRENCY: "1", SHUTDOWN_GRACE_SECONDS: "1", UPLOAD_IDLE_TIMEOUT_SECONDS: "1", JOB_TTL_SECONDS: "259200", CLEANUP_INTERVAL_SECONDS: "1", YT_DLP_PATH: join(fixture, "yt-dlp"), FFMPEG_PATH: join(fixture, "ffmpeg"), WHISPER_CLI_PATH: join(fixture, "whisper-cli"), WHISPER_MODEL_PATH: join(fixture, "fixture-model.bin"), WHISPER_FIXTURE_DELAY_MS: "0", ...extra },
    stdout: "pipe", stderr: "pipe",
  });
  children.push(child);
  const logs = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  try {
    await eventually(async () => { try { return (await fetch(`${origin}/health`)).status; } catch { return 0; } }, status => status === 200);
  } catch (error) {
    child.kill("SIGKILL"); await child.exited;
    throw new Error(`Server did not start: ${(await logs).join("\n")}`, { cause: error });
  }
  return {
    dir, origin, child,
    upload: (data: Uint8Array = body, moreHeaders: Record<string, string> = {}) => fetch(`${origin}/api/transcribe`, { method: "POST", headers: { ...headers, ...moreHeaders }, body: data }),
    job: async (id: string) => (await fetch(`${origin}/api/jobs/${id}`)).json() as Promise<any>,
    async stop(signal: "SIGTERM" | "SIGKILL" = "SIGTERM") {
      child.kill(signal);
      const exited = await Promise.race([child.exited.then(() => true), Bun.sleep(3000).then(() => false)]);
      if (!exited) { child.kill("SIGKILL"); throw new Error("Shutdown exceeded its deadline"); }
      await logs;
    },
  };
}

afterEach(async () => {
  for (const child of children.splice(0)) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; }
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});

describe("durable web runtime", () => {
  test("runs two uploads simultaneously and queues the third", async () => {
    const server = await start(undefined, { JOB_CONCURRENCY: "2", WHISPER_FIXTURE_DELAY_MS: "800" });
    const first = await (await server.upload()).json() as any;
    const second = await (await server.upload()).json() as any;
    await eventually(async () => Promise.all([server.job(first.jobId), server.job(second.jobId)]), jobs => jobs.every(job => job.status === "processing"));
    const third = await (await server.upload()).json() as any;
    expect(await server.job(third.jobId)).toMatchObject({ status: "queued", position: 1 });
    const completed = await Promise.all([first, second, third].map(job => eventually(() => server.job(job.jobId), value => value.status === "completed")));
    expect(completed[0].startedAt).toBeLessThan(completed[1].finishedAt);
    expect(completed[1].startedAt).toBeLessThan(completed[0].finishedAt);
  }, 10000);

  test("extracts MP3 audio from a local upload through the shared queue", async () => {
    const server = await start();
    const response = await fetch(`${server.origin}/api/transcribe?format=mp3`, { method: "POST", headers, body });
    expect(response.status).toBe(202);
    const accepted = await response.json() as any;
    const done = await eventually(() => server.job(accepted.jobId), value => value.status === "completed");
    expect(done).toMatchObject({ format: "mp3", filename: "audio.mp3" });
    const download = await fetch(`${server.origin}/downloads/${accepted.jobId}`);
    expect(download.headers.get("content-type")).toBe("audio/mpeg");
    expect((await download.arrayBuffer()).byteLength).toBeGreaterThan(0);
    expect((await fetch(`${server.origin}/api/transcribe?format=exe`, { method: "POST", headers, body })).status).toBe(400);
  }, 10000);

  test("queues uploads and URL jobs together and preserves completed downloads across restart", async () => {
    const server = await start(undefined, { WHISPER_FIXTURE_DELAY_MS: "350" });
    const firstResponse = await server.upload();
    expect(firstResponse.status).toBe(202);
    const first = await firstResponse.json() as any;
    expect(first.status).toBe("queued");
    expect(first.jobId).toMatch(/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    await eventually(() => server.job(first.jobId), job => job.status === "processing");
    const second = await (await server.upload()).json() as any;
    expect(second).toMatchObject({ status: "queued", position: 1 });
    const thirdResponse = await fetch(`${server.origin}/api/convert`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: "https://www.youtube.com/watch?v=fixture12345", format: "transcript" }) });
    expect(thirdResponse.status).toBe(202);
    const third = await thirdResponse.json() as any;
    expect(third.position).toBe(2);
    const firstDone = await eventually(() => server.job(first.jobId), job => job.status === "completed");
    const secondDone = await eventually(() => server.job(second.jobId), job => job.status === "completed");
    const thirdDone = await eventually(() => server.job(third.jobId), job => job.status === "completed");
    expect(firstDone.finishedAt).toBeLessThanOrEqual(secondDone.startedAt);
    expect(secondDone.finishedAt).toBeLessThanOrEqual(thirdDone.startedAt);
    expect(firstDone.sourcePath).toBeUndefined();
    expect(firstDone.sourceBytes).toBeUndefined();
    expect(firstDone.position).toBeNull();
    await server.stop();
    const reopened = await start(server.dir);
    expect(await reopened.job(first.jobId)).toEqual(firstDone);
    expect(await (await fetch(`${reopened.origin}/downloads/${first.jobId}`)).text()).toContain("local speech-to-text fixture");
    expect(await (await fetch(`${reopened.origin}/downloads/${third.jobId}`)).text()).toContain("shared download path works");
  }, 15000);

  test("recovers a killed processing job, resumes queued work, and preserves unrelated files", async () => {
    const server = await start(undefined, { WHISPER_FIXTURE_DELAY_MS: "1000" });
    await writeFile(join(server.dir, "old-download.txt"), "keep me");
    const first = await (await server.upload()).json() as any;
    await eventually(() => server.job(first.jobId), job => job.status === "processing");
    const second = await (await server.upload()).json() as any;
    await server.stop("SIGKILL");
    const reopened = await start(server.dir);
    expect(await reopened.job(first.jobId)).toMatchObject({ status: "failed", errorCode: "PROCESS_INTERRUPTED" });
    await eventually(() => reopened.job(second.jobId), job => job.status === "completed");
    expect(await Bun.file(join(server.dir, "old-download.txt")).text()).toBe("keep me");
    expect(await readdir(join(server.dir, ".uploads"))).toEqual([]);
  }, 10000);

  test("SIGTERM rejects admissions while active work finishes and preserves queued work", async () => {
    const server = await start(undefined, { WHISPER_FIXTURE_DELAY_MS: "700", SHUTDOWN_GRACE_SECONDS: "2" });
    const first = await (await server.upload()).json() as any;
    await eventually(() => server.job(first.jobId), job => job.status === "processing");
    const second = await (await server.upload()).json() as any;
    server.child.kill("SIGTERM");
    await eventually(async () => (await fetch(`${server.origin}/health`)).status, status => status === 503);
    const rejected = await server.upload();
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toMatchObject({ code: "SHUTTING_DOWN" });
    expect((await server.job(first.jobId)).status).toBe("processing");
    await server.child.exited;
    const reopened = await start(server.dir);
    expect((await reopened.job(first.jobId)).status).toBe("completed");
    await eventually(() => reopened.job(second.jobId), job => job.status === "completed");
  }, 15000);

  test("shutdown deadline exits even with an unfinished worker", async () => {
    const server = await start(undefined, { WHISPER_FIXTURE_DELAY_MS: "5000", SHUTDOWN_GRACE_SECONDS: "1" });
    const job = await (await server.upload()).json() as any;
    await eventually(() => server.job(job.jobId), job => job.status === "processing");
    const began = Date.now();
    await server.stop();
    expect(Date.now() - began).toBeLessThan(2500);
    const reopened = await start(server.dir);
    expect(await reopened.job(job.jobId)).toMatchObject({ status: "failed", errorCode: "PROCESS_INTERRUPTED" });
  }, 10000);

  test("enforces exact upload caps and releases capacity after rejection", async () => {
    const server = await start();
    expect((await server.upload(new Uint8Array(1024 * 1024 + 1))).status).toBe(413);
    expect(await readdir(join(server.dir, ".uploads"))).toEqual([]);
    const exact = await server.upload(new Uint8Array(1024 * 1024));
    expect(exact.status).toBe(202);
    const job = await exact.json() as any;
    await eventually(() => server.job(job.jobId), value => value.status === "completed");
    expect(await readdir(join(server.dir, ".uploads"))).toEqual([]);
    const form = new FormData(); form.append("file", new File([body], "video.mp4"));
    expect((await fetch(`${server.origin}/api/transcribe`, { method: "POST", body: form })).status).toBe(415);
  }, 10000);

  test("idle and disconnected chunked uploads release their reservations", async () => {
    const server = await start(undefined, { MAX_QUEUE_SIZE: "1" });
    const status = await new Promise<number>(resolveStatus => {
      const request = httpRequest(`${server.origin}/api/transcribe`, { method: "POST", headers, agent: false }, response => { response.resume(); response.on("end", () => { request.destroy(); resolveStatus(response.statusCode!); }); });
      request.on("error", () => {});
      request.write(body);
    });
    expect(status).toBe(408);
    await eventually(() => readdir(join(server.dir, ".uploads")), files => files.length === 0);
    const request = httpRequest(`${server.origin}/api/transcribe`, { method: "POST", headers, agent: false, }, response => response.resume());
    request.on("error", () => {}); request.write(body); request.flushHeaders();
    await eventually(() => readdir(join(server.dir, ".uploads")), files => files.length === 1);
    request.destroy();
    await eventually(() => readdir(join(server.dir, ".uploads")), files => files.length === 0);
    expect((await server.upload()).status).toBe(202);
  }, 10000);

  test("queue pressure and free disk checks return stable errors", async () => {
    const server = await start(undefined, { MAX_QUEUE_SIZE: "1", WHISPER_FIXTURE_DELAY_MS: "500" });
    const first = await (await server.upload()).json() as any;
    await eventually(() => server.job(first.jobId), value => value.status === "processing");
    expect((await server.upload()).status).toBe(202);
    const full = await server.upload();
    expect(full.status).toBe(429); expect(full.headers.get("Retry-After")).not.toBeNull();
    expect(await full.json()).toMatchObject({ code: "QUEUE_FULL" });
    const disk = await start(undefined, { MIN_FREE_DISK_BYTES: String(Number.MAX_SAFE_INTEGER) });
    const rejected = await disk.upload();
    expect(rejected.status).toBe(507); expect(await rejected.json()).toMatchObject({ code: "INSUFFICIENT_STORAGE" });
    expect(await readdir(join(disk.dir, ".uploads"))).toEqual([]);
  }, 10000);

  test("expired jobs become unavailable and cleanup preserves unrelated downloads", async () => {
    const server = await start(undefined, { JOB_TTL_SECONDS: "1" });
    await writeFile(join(server.dir, "unrelated.txt"), "keep");
    const started = await (await server.upload()).json() as any;
    const done = await eventually(() => server.job(started.jobId), value => value.status === "completed");
    await eventually(async () => (await fetch(`${server.origin}/api/jobs/${started.jobId}`)).status, value => value === 404);
    expect((await fetch(`${server.origin}/downloads/${started.jobId}`)).status).toBe(404);
    await eventually(async () => Bun.file(done.outputPath).exists(), exists => !exists);
    const database = new Database(join(server.dir, ".state/jobs.sqlite"), { readonly: true });
    expect(database.query("SELECT COUNT(*) AS count FROM jobs").get()).toEqual({ count: 0 }); database.close();
    expect(await Bun.file(join(server.dir, "unrelated.txt")).text()).toBe("keep");
  }, 10000);
});
