import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InsufficientStorageError,
  JobStore,
  QueueFullError,
} from "./jobs.js";

const options = (stateDir: string) => ({
  stateDir,
  maxQueueSize: 2,
  maxPendingUploadBytes: 100,
  jobTtlSeconds: 10,
});

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yt-converter-jobs-"));
}

function urlJob(id: string, createdAt = 100): Parameters<JobStore["enqueueUrl"]>[0] {
  return { id, kind: "url", format: "transcript", url: "https://youtu.be/test", createdAt };
}

test("persists transitions across reopen and preserves createdAt", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(options(dir));
  const queued = store.enqueueUrl(urlJob("job-1", 100));
  expect(queued.createdAt).toBe(100);
  expect(queued.queuedAt).toBe(100);
  const processing = store.claimNext()!;
  const completed = store.complete(processing.id, {
    outputPath: "/tmp/output.mp3",
    filename: "output.mp3",
    now: 200,
    sourceReleased: true,
  });
  expect(completed.status).toBe("completed");
  expect(completed.createdAt).toBe(100);
  expect(completed.startedAt).toBeDefined();
  store.close();

  const reopened = await JobStore.open(options(dir));
  expect(reopened.get("job-1")).toMatchObject({
    status: "completed",
    createdAt: 100,
    finishedAt: 200,
    outputPath: "/tmp/output.mp3",
  });
  const synchronous = reopened.db.query("PRAGMA synchronous").get() as { synchronous: number };
  expect(synchronous.synchronous).toBe(2);
  reopened.close();
  await rm(dir, { recursive: true, force: true });
});

test("guards unsupported SQLite schema versions", async () => {
  const dir = await makeDir();
  const first = await JobStore.open(options(dir));
  first.close();
  const database = new Database(join(dir, "jobs.sqlite"));
  database.exec("PRAGMA user_version = 99");
  database.close();
  expect(() => new JobStore(options(dir))).toThrow(/Unsupported jobs database schema version 99/);
  await rm(dir, { recursive: true, force: true });
});

test("counts reservations with queue capacity and pending bytes", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(options(dir));
  store.reserveUpload({ id: "upload-1", reservedBytes: 60, partialPath: "/tmp/one.part", createdAt: 1 });
  expect(store.waitingCount()).toBe(1);
  expect(store.pendingUploadBytes()).toBe(60);
  store.enqueueUrl(urlJob("url-1"));
  expect(store.waitingCount()).toBe(2);
  expect(() => store.enqueueUrl(urlJob("url-2"))).toThrow(QueueFullError);
  expect(() => store.reserveUpload({ id: "upload-2", reservedBytes: 41, partialPath: "/tmp/two.part", createdAt: 2 })).toThrow(QueueFullError);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("atomically enqueues only a matching upload reservation", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(options(dir));
  store.reserveUpload({ id: "upload-1", reservedBytes: 10, partialPath: "/tmp/one.part", createdAt: 1 });
  expect(() => store.enqueueUpload({
    id: "other-id",
    kind: "upload",
    format: "mp4",
    sourcePath: "/tmp/source",
    sourceBytes: 1,
  }, "upload-1")).toThrow(/ids must match/);
  expect(() => store.enqueueUpload({
    id: "upload-1",
    kind: "upload",
    format: "mp4",
    sourcePath: "/tmp/source",
    sourceBytes: 11,
  }, "upload-1")).toThrow(InsufficientStorageError);
  expect(store.getUploadReservation("upload-1")).toBeDefined();
  const job = store.enqueueUpload({
    id: "upload-1",
    kind: "upload",
    format: "mp4",
    sourcePath: "/tmp/source",
    sourceBytes: 8,
  }, "upload-1");
  expect(job.kind).toBe("upload");
  expect(store.pendingUploadBytes()).toBe(8);
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("recovers processing jobs and exposes safe cleanup queries", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(options(dir));
  store.enqueueUrl(urlJob("url-1", 10));
  store.claimNext();
  const recovered = store.recoverProcessing(50);
  expect(recovered[0]).toMatchObject({ status: "failed", errorCode: "PROCESS_INTERRUPTED", createdAt: 10 });
  store.reserveUpload({ id: "upload-1", reservedBytes: 20, partialPath: "/tmp/one.part", createdAt: 11 });
  store.enqueueUpload({
    id: "upload-1",
    kind: "upload",
    format: "mp4",
    sourcePath: "/tmp/missing-source",
    sourceBytes: 18,
    createdAt: 11,
  }, "upload-1");
  store.claimNext();
  const recoveredUpload = store.recoverProcessing(60);
  expect(recoveredUpload[0]).toMatchObject({ status: "failed", errorCode: "PROCESS_INTERRUPTED", createdAt: 11 });
  expect(store.terminalJobsRetainingSources()).toHaveLength(1);
  expect(store.pendingUploadBytes()).toBe(18);
  expect(store.forgetSource("upload-1")?.sourceBytes).toBeUndefined();
  expect(store.pendingUploadBytes()).toBe(0);

  const queued = store.enqueueUrl(urlJob("url-2"));
  expect(store.failQueuedMissingSource(queued.id)).toBeUndefined();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("fails queued uploads whose source vanished and retries expired cleanup safely", async () => {
  const dir = await makeDir();
  const store = await JobStore.open(options(dir));
  store.reserveUpload({ id: "upload-1", reservedBytes: 20, partialPath: "/tmp/one.part", createdAt: 1 });
  const job = store.enqueueUpload({
    id: "upload-1",
    kind: "upload",
    format: "mp4",
    sourcePath: "/tmp/missing-source",
    sourceBytes: 20,
    createdAt: 1,
  }, "upload-1");
  const failed = store.failQueuedMissingSource(job.id, 5)!;
  expect(failed).toMatchObject({ status: "failed", errorCode: "SOURCE_MISSING", finishedAt: 5 });
  expect(store.pendingUploadBytes()).toBe(0);
  expect(store.expired(10005)).toHaveLength(1);
  expect(store.deleteExpired(job.id, 10005)).toBe(true);
  expect(store.get(job.id)).toBeUndefined();
  store.close();
  await rm(dir, { recursive: true, force: true });
});

test("migrates version 1 jobs without losing queued work or upload reservations", async () => {
  const dir = await makeDir();
  const original = await JobStore.open(options(dir));
  original.enqueueUrl(urlJob("existing"));
  original.reserveUpload({ id: "upload", reservedBytes: 10, partialPath: "/tmp/upload.part", createdAt: 100 });
  const schema = original.db.query("SELECT sql FROM sqlite_master WHERE name = 'jobs'").get() as { sql: string };
  original.db.transaction(() => {
    original.db.exec(schema.sql.replace("CREATE TABLE jobs", "CREATE TABLE old_jobs").replace(", 'instrumental'", ""));
    original.db.exec("INSERT INTO old_jobs SELECT * FROM jobs; DROP TABLE jobs; ALTER TABLE old_jobs RENAME TO jobs; PRAGMA user_version = 1;");
  })();
  original.close();
  const migrated = await JobStore.open(options(dir));
  expect(migrated.get("existing")?.status).toBe("queued");
  expect(migrated.reservations()).toHaveLength(1);
  migrated.releaseUploadReservation("upload");
  expect(migrated.enqueueUrl({ ...urlJob("new"), format: "instrumental" }).format).toBe("instrumental");
  migrated.close();
  await rm(dir, { recursive: true, force: true });
});

test("lists jobs in queue order and narrows to queued or source-retaining terminal jobs", async () => {
  const dir = await makeDir();
  const store = await JobStore.open({ ...options(dir), maxQueueSize: 5 });
  store.enqueueUrl(urlJob("first", 1));
  store.enqueueUrl(urlJob("second", 2));
  store.reserveUpload({ id: "upload-1", reservedBytes: 20, partialPath: "/tmp/one.part", createdAt: 3 });
  store.enqueueUpload({ id: "upload-1", kind: "upload", format: "mp3", sourcePath: "/tmp/one.source", sourceBytes: 5 }, "upload-1");
  const claimed = store.claimNext()!;
  store.complete(claimed.id, { outputPath: "/tmp/first.txt", filename: "first.txt", sourceReleased: true });

  expect(store.listJobs().map(job => job.id)).toEqual(["first", "second", "upload-1"]);
  expect(store.listAll()).toEqual(store.allJobs());
  expect(store.queuedJobs().map(job => job.id)).toEqual(["second", "upload-1"]);
  expect(store.listTerminalJobsWithSources()).toEqual([]);

  store.claimNext();
  const upload = store.claimNext()!;
  store.fail(upload.id, { error: "boom", errorCode: "FAILED", sourceReleased: false });
  expect(store.listTerminalJobsWithSources().map(job => job.id)).toEqual(["upload-1"]);
  expect(store.forgetJobSource("upload-1")?.sourcePath).toBeUndefined();
  expect(store.forgetJobSource("upload-1")).toBeUndefined();
  expect(store.listTerminalJobsWithSources()).toEqual([]);
  store.close();
  await rm(dir, { recursive: true, force: true });
});
