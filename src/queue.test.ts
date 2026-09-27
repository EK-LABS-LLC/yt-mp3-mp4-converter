import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./jobs.js";
import { JobQueue } from "./queue.js";

const storeOptions = (stateDir: string) => ({
  stateDir,
  maxQueueSize: 10,
  maxPendingUploadBytes: 100,
  jobTtlSeconds: 60,
});

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yt-converter-queue-"));
}

function job(id: string) {
  return { id, kind: "url" as const, format: "transcript" as const, url: "https://youtu.be/test" };
}

async function waitFor(check: () => boolean, timeout = 1000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("condition did not become true");
    await Bun.sleep(2);
  }
}

test("starts paused, then dispatches FIFO with the configured concurrency", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  const order: string[] = [];
  let active = 0;
  let maxActive = 0;
  const queue = new JobQueue(store, {
    concurrency: 1,
    worker: async (current) => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(current.id);
      await Bun.sleep(8);
      active--;
      return { outputPath: `/tmp/${current.id}.out`, filename: `${current.id}.out` };
    },
  });
  queue.enqueueUrl(job("one"));
  queue.enqueueUrl(job("two"));
  expect(order).toEqual([]);
  queue.start();
  await waitFor(() => store.get("two")?.status === "completed");
  expect(order).toEqual(["one", "two"]);
  expect(maxActive).toBe(1);
  expect(store.get("one")?.status).toBe("completed");
  expect(store.get("two")?.status).toBe("completed");
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("releases upload bytes after successful cleanup and on ENOENT", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  const source = join(dir, "source.bin");
  await writeFile(source, "source");
  store.reserveUpload({ id: "upload-1", reservedBytes: 20, partialPath: join(dir, "one.part"), createdAt: 1 });
  store.enqueueUpload({
    id: "upload-1", kind: "upload", format: "mp4", sourcePath: source, sourceBytes: 6,
  }, "upload-1");
  const missing = join(dir, "already-missing.bin");
  store.reserveUpload({ id: "upload-2", reservedBytes: 20, partialPath: join(dir, "two.part"), createdAt: 2 });
  store.enqueueUpload({
    id: "upload-2", kind: "upload", format: "mp4", sourcePath: missing, sourceBytes: 7,
  }, "upload-2");
  const queue = new JobQueue(store, {
    concurrency: 1,
    worker: async (current) => {
      if (current.id === "upload-1") throw Object.assign(new Error("conversion failed"), { code: "CONVERSION_FAILED" });
      return { outputPath: "/tmp/result", filename: "result.mp4" };
    },
  });
  queue.start();
  await waitFor(() => store.get("upload-2")?.status === "completed");
  expect(store.get("upload-1")).toMatchObject({ status: "failed", errorCode: "CONVERSION_FAILED" });
  expect(store.pendingUploadBytes()).toBe(0);
  expect(store.get("upload-1")?.sourcePath).toBeUndefined();
  expect(store.get("upload-2")?.sourcePath).toBeUndefined();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("retains source accounting when cleanup fails and invokes beforeWork", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  const sourceDir = join(dir, "source-dir");
  await mkdir(sourceDir);
  await writeFile(join(sourceDir, "child"), "keep the directory non-empty");
  store.reserveUpload({ id: "upload-1", reservedBytes: 20, partialPath: join(dir, "one.part"), createdAt: 1 });
  store.enqueueUpload({
    id: "upload-1", kind: "upload", format: "mp4", sourcePath: sourceDir, sourceBytes: 9,
  }, "upload-1");
  let admitted = false;
  const queue = new JobQueue(store, {
    concurrency: 1,
    beforeWork: () => { admitted = true; },
    worker: async () => ({ outputPath: "/tmp/result", filename: "result.mp4" }),
  });
  queue.start();
  await waitFor(() => store.get("upload-1")?.status === "completed");
  expect(admitted).toBe(true);
  expect(store.pendingUploadBytes()).toBe(9);
  expect(store.get("upload-1")?.sourcePath).toBe(sourceDir);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("drain clears its timeout when active work finishes", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  let finish!: () => void;
  const workFinished = new Promise<void>((resolve) => { finish = resolve; });
  const queue = new JobQueue(store, {
    concurrency: 1,
    worker: async () => {
      await workFinished;
      return { outputPath: "/tmp/result", filename: "result" };
    },
  });
  queue.enqueueUrl(job("one"));
  queue.start();
  await waitFor(() => queue.activeCount() === 1);
  const draining = queue.drain(1);
  finish();
  expect(await draining).toBe(true);
  expect(queue.activeCount()).toBe(0);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("treats completion persistence failure as fatal instead of a job failure", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  let finish!: () => void;
  const workFinished = new Promise<void>((resolve) => { finish = resolve; });
  const fatalErrors: unknown[] = [];
  const queue = new JobQueue(store, {
    concurrency: 1,
    onFatal: (error) => { fatalErrors.push(error); },
    worker: async () => {
      await workFinished;
      return { outputPath: "/tmp/published", filename: "published.mp4" };
    },
  });
  queue.enqueueUrl(job("one"));
  queue.start();
  await waitFor(() => queue.activeCount() === 1);
  store.close();
  finish();
  await waitFor(() => fatalErrors.length === 1);
  expect(fatalErrors[0]).toBeInstanceOf(Error);
  expect(queue.activeCount()).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("dispatches uploads enqueued through the queue once started", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  const source = join(dir, "upload.source");
  await writeFile(source, "media");
  const queue = new JobQueue(store, {
    concurrency: 1,
    worker: async (current) => ({ outputPath: `/tmp/${current.id}.mp3`, filename: "audio.mp3" }),
  });
  expect(queue.isDraining()).toBe(true);
  queue.start();
  expect(queue.isDraining()).toBe(false);
  store.reserveUpload({ id: "upload-1", reservedBytes: 20, partialPath: join(dir, "upload.part"), createdAt: 1 });
  const queued = queue.enqueueUpload({ id: "upload-1", kind: "upload", format: "mp3", sourcePath: source, sourceBytes: 5 }, "upload-1");
  expect(queued.status).toBe("queued");
  await waitFor(() => store.get("upload-1")?.status === "completed");
  expect(store.get("upload-1")?.sourcePath).toBeUndefined();
  expect(await Bun.file(source).exists()).toBe(false);
  queue.stopDispatch();
  expect(queue.isDraining()).toBe(true);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("drain reports incomplete work when the grace period expires", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(storeOptions(dir));
  let finish!: () => void;
  const workFinished = new Promise<void>((resolve) => { finish = resolve; });
  const queue = new JobQueue(store, {
    concurrency: 1,
    worker: async () => {
      await workFinished;
      return { outputPath: "/tmp/result", filename: "result" };
    },
  });
  queue.enqueueUrl(job("one"));
  queue.start();
  await waitFor(() => queue.activeCount() === 1);
  expect(await queue.drain(0)).toBe(false);
  expect(queue.activeCount()).toBe(1);
  finish();
  await waitFor(() => queue.activeCount() === 0);
  expect(store.get("one")?.status).toBe("completed");
  store.close();
  await rm(dir, { recursive: true, force: true });
});
