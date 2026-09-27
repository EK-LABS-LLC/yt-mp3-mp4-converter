import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueFullError } from "./jobs.js";
import { FileSizeError } from "./errors.js";
import { streamUpload, UploadValidationError } from "./uploads.js";

async function makeDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "yt-converter-upload-"));
}

function requestFromChunks(
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
  cancel?: () => Promise<void>,
): Request {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
    cancel,
  });
  return new Request("http://localhost/api/transcribe", {
    method: "POST",
    headers,
    body,
    duplex: "half",
  });
}

function neverEndingRequest(headers: Record<string, string>, signal?: AbortSignal, cancel?: () => Promise<void>): Request {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      return new Promise<void>(() => undefined);
    },
    cancel,
  });
  return new Request("http://localhost/api/transcribe", {
    method: "POST",
    headers,
    body,
    duplex: "half",
    signal,
  });
}

function uploadOptions(uploadDir: string, overrides: Partial<Parameters<typeof streamUpload>[1]> = {}) {
  const reservations = new Map<string, number>();
  return {
    uploadDir,
    maxBytes: 4,
    idleTimeoutSeconds: 1,
    supportedExtensions: new Set([".mp4"]),
    reserve: (id: string, bytes: number) => { reservations.set(id, bytes); },
    release: (id: string) => { reservations.delete(id); },
    ...overrides,
    reservations,
  };
}

test("streams an exact-cap raw upload and leaves its reservation for enqueue", async () => {
  const dir = await makeDir();
  const options = uploadOptions(dir);
  const result = await streamUpload(requestFromChunks([
    new TextEncoder().encode("ab"),
    new TextEncoder().encode("cd"),
  ], {
    "content-type": "application/octet-stream",
    "content-length": "4",
    "x-upload-filename": "clip%20one.mp4",
  }), options);
  expect(result.bytes).toBe(4);
  expect(result.reservationBytes).toBe(4);
  expect(result.sourcePath).not.toContain("clip");
  expect(await readFile(result.sourcePath, "utf8")).toBe("abcd");
  expect(options.reservations.get(result.reservationId)).toBe(4);
  await rm(dir, { recursive: true, force: true });
});

test("rejects cap plus one without retaining a partial file", async () => {
  const dir = await makeDir();
  const options = uploadOptions(dir);
  const request = requestFromChunks([new TextEncoder().encode("abcde")], {
    "content-type": "application/octet-stream",
    "x-upload-filename": "clip.mp4",
  });
  await expect(streamUpload(request, options)).rejects.toBeInstanceOf(FileSizeError);
  expect(options.reservations.size).toBe(0);
  expect(await readdir(dir)).toEqual([]);
  await rm(dir, { recursive: true, force: true });
});

test("distinguishes declared-length mismatch from a real cap violation", async () => {
  const dir = await makeDir();
  const options = uploadOptions(dir);
  const request = requestFromChunks([new TextEncoder().encode("abc")], {
    "content-type": "application/octet-stream",
    "content-length": "2",
    "x-upload-filename": "clip.mp4",
  });
  await expect(streamUpload(request, options)).rejects.toMatchObject({ code: "CONTENT_LENGTH_MISMATCH", statusCode: 400 });
  expect(options.reservations.size).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("rejects missing filename and multipart clients before reserving", async () => {
  const dir = await makeDir();
  const options = uploadOptions(dir);
  await expect(streamUpload(requestFromChunks([new Uint8Array([1])], {
    "content-type": "application/octet-stream",
  }), options)).rejects.toMatchObject({ code: "FILE_REQUIRED", statusCode: 400 });
  await expect(streamUpload(requestFromChunks([new Uint8Array([1])], {
    "content-type": "multipart/form-data; boundary=abc",
    "x-upload-filename": "clip.mp4",
  }), options)).rejects.toMatchObject({ code: "MULTIPART_UNSUPPORTED", statusCode: 415 });
  expect(options.reservations.size).toBe(0);
  await rm(dir, { recursive: true, force: true });
});

test("preserves reserve callback admission errors", async () => {
  const dir = await makeDir();
  const admissionError = new QueueFullError();
  const options = uploadOptions(dir, { reserve: () => { throw admissionError; } });
  await expect(streamUpload(requestFromChunks([new Uint8Array([1])], {
    "content-type": "application/octet-stream",
    "content-length": "1",
    "x-upload-filename": "clip.mp4",
  }), options)).rejects.toBe(admissionError);
  await rm(dir, { recursive: true, force: true });
});

test("times out idle streams and responds promptly to abort", async () => {
  const dir = await makeDir();
  const options = uploadOptions(dir, { idleTimeoutSeconds: 0.01 });
  const started = Date.now();
  await expect(streamUpload(neverEndingRequest({
    "content-type": "application/octet-stream",
    "x-upload-filename": "clip.mp4",
  }, undefined, () => new Promise(() => undefined)), options)).rejects.toMatchObject({ code: "UPLOAD_TIMEOUT", statusCode: 408 });
  expect(Date.now() - started).toBeLessThan(500);

  const controller = new AbortController();
  const aborted = streamUpload(neverEndingRequest({
    "content-type": "application/octet-stream",
    "x-upload-filename": "clip.mp4",
  }, controller.signal, () => new Promise(() => undefined)), uploadOptions(dir, { signal: controller.signal }));
  setTimeout(() => controller.abort(), 5);
  await expect(aborted).rejects.toMatchObject({ code: "UPLOAD_ABORTED", statusCode: 499 });
  await rm(dir, { recursive: true, force: true });
});

test("retains a reservation when partial-file cleanup cannot delete it", async () => {
  const dir = await makeDir();
  let reservedId = "";
  const options = uploadOptions(dir, {
    reserve: async (id: string, bytes: number, partialPath: string) => {
      reservedId = id;
      await mkdir(partialPath);
      await writeFile(join(partialPath, "keep"), "x");
      options.reservations.set(id, bytes);
    },
  });
  await expect(streamUpload(requestFromChunks([new Uint8Array([1])], {
    "content-type": "application/octet-stream",
    "content-length": "1",
    "x-upload-filename": "clip.mp4",
  }), options)).rejects.toMatchObject({ code: "INSUFFICIENT_STORAGE", statusCode: 507 });
  expect(options.reservations.get(reservedId)).toBe(1);
  await rm(dir, { recursive: true, force: true });
});
