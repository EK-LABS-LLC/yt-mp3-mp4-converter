import { mkdir, open, rename, rm } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { ConverterError, FileSizeError } from "./errors.js";

const MAX_WRITE_CHUNK_BYTES = 1024 * 1024;

export interface UploadStreamOptions {
  uploadDir: string;
  maxBytes: number;
  idleTimeoutSeconds: number;
  supportedExtensions: Set<string>;
  reserve: (id: string, bytes: number, partialPath: string) => Promise<void> | void;
  release: (id: string) => Promise<void> | void;
  signal?: AbortSignal;
}

export interface StreamedUpload {
  id: string;
  sourcePath: string;
  filename: string;
  bytes: number;
  reservationBytes: number;
  reservationId: string;
}

export class UploadValidationError extends ConverterError {
  constructor(message: string, code = "FILE_REQUIRED", statusCode = 400) {
    super(message, code, statusCode);
    this.name = "UploadValidationError";
  }
}

export class UploadStorageError extends ConverterError {
  constructor(message: string) {
    super(message, "INSUFFICIENT_STORAGE", 507);
    this.name = "UploadStorageError";
  }
}

function decodeFilename(header: string | null): string {
  if (!header) throw new UploadValidationError("X-Upload-Filename is required", "FILE_REQUIRED");
  let filename: string;
  try {
    filename = decodeURIComponent(header);
  } catch {
    throw new UploadValidationError("X-Upload-Filename is not valid percent-encoding", "INVALID_FILENAME");
  }
  if (!filename || filename.length > 255 || /[\x00-\x1f\x7f]/.test(filename)) {
    throw new UploadValidationError("X-Upload-Filename is invalid", "INVALID_FILENAME");
  }
  return filename;
}

interface DeclaredLength {
  bytes: number;
  supplied: boolean;
}

function declaredLength(request: Request, maxBytes: number): DeclaredLength {
  const header = request.headers.get("content-length");
  if (!header) return { bytes: maxBytes, supplied: false };
  if (!/^\d+$/.test(header)) throw new UploadValidationError("Content-Length is invalid", "INVALID_CONTENT_LENGTH");
  const value = Number(header);
  if (!Number.isSafeInteger(value)) throw new UploadValidationError("Content-Length is invalid", "INVALID_CONTENT_LENGTH");
  if (value === 0) throw new UploadValidationError("Uploaded file is empty", "EMPTY_FILE");
  if (value > maxBytes) throw new FileSizeError(Math.ceil(maxBytes / 1024 / 1024), value / 1024 / 1024);
  return { bytes: value, supplied: true };
}

type ReaderResult = { done: boolean; value?: Uint8Array };
type UploadReader = {
  read: () => Promise<ReaderResult>;
  cancel: (reason?: unknown) => Promise<unknown>;
};

function abortError(): UploadValidationError {
  return new UploadValidationError("The upload was aborted", "UPLOAD_ABORTED", 499);
}

async function readWithTimeout(
  reader: UploadReader,
  timeoutSeconds: number,
  signal?: AbortSignal,
): Promise<ReaderResult> {
  if (signal?.aborted) throw abortError();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const read = reader.read();
  const timeout = timeoutSeconds > 0
    ? new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new UploadValidationError(
        "Upload timed out while waiting for data",
        "UPLOAD_TIMEOUT",
        408,
      )), timeoutSeconds * 1000);
    })
    : undefined;
  const aborted = signal
    ? new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
    })
    : undefined;
  try {
    const promises: Array<Promise<ReaderResult> | Promise<never>> = [read];
    if (timeout) promises.push(timeout);
    if (aborted) promises.push(aborted);
    return await Promise.race(promises);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function writeChunk(file: Awaited<ReturnType<typeof open>>, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.byteLength) {
    const end = Math.min(offset + MAX_WRITE_CHUNK_BYTES, bytes.byteLength);
    const piece = bytes.subarray(offset, end);
    let written = 0;
    while (written < piece.byteLength) {
      const result = await file.write(piece, written, piece.byteLength - written);
      if (result.bytesWritten <= 0) throw new UploadStorageError("The upload could not be written to disk");
      written += result.bytesWritten;
    }
    offset = end;
  }
}

async function removePath(path: string): Promise<boolean> {
  try {
    await rm(path, { force: false });
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

function storageError(error: unknown): UploadStorageError {
  return new UploadStorageError(error instanceof Error ? error.message : String(error));
}

export async function streamUpload(request: Request, options: UploadStreamOptions): Promise<StreamedUpload> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType?.startsWith("multipart/")) {
    throw new UploadValidationError("This server now accepts raw uploads; reload the page and try again", "MULTIPART_UNSUPPORTED", 415);
  }
  if (contentType !== "application/octet-stream") {
    throw new UploadValidationError("Content-Type must be application/octet-stream", "INVALID_CONTENT_TYPE", 415);
  }

  const filename = decodeFilename(request.headers.get("x-upload-filename"));
  const extension = extname(filename).toLowerCase();
  if (!options.supportedExtensions.has(extension)) {
    throw new UploadValidationError("Upload must have a supported audio or video extension", "INVALID_FILE_TYPE", 415);
  }

  const body = request.body;
  if (!body) throw new UploadValidationError("Upload one video or audio file", "FILE_REQUIRED");
  const length = declaredLength(request, options.maxBytes);
  const id = crypto.randomUUID();
  const reservationId = id;
  const partialPath = resolve(options.uploadDir, `${id}.part`);
  const sourcePath = resolve(options.uploadDir, `${id}.source`);
  const signal = options.signal ?? request.signal;
  let reserved = false;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let reader: UploadReader | undefined;

  try {
    try {
      await mkdir(options.uploadDir, { recursive: true });
    } catch (error) {
      throw storageError(error);
    }

    // Preserve admission errors such as QUEUE_FULL (429); only filesystem
    // failures are storage failures.
    await options.reserve(reservationId, length.bytes, partialPath);
    reserved = true;

    try {
      handle = await open(partialPath, "wx");
      reader = body.getReader();
      let bytes = 0;
      while (true) {
        const chunk = await readWithTimeout(reader, options.idleTimeoutSeconds, signal);
        if (chunk.done) break;
        const value = chunk.value;
        if (!value || value.byteLength === 0) continue;
        const nextBytes = bytes + value.byteLength;
        if (nextBytes > options.maxBytes) {
          throw new FileSizeError(Math.ceil(options.maxBytes / 1024 / 1024), nextBytes / 1024 / 1024);
        }
        if (length.supplied && nextBytes > length.bytes) {
          throw new UploadValidationError(
            "Upload exceeded Content-Length",
            "CONTENT_LENGTH_MISMATCH",
          );
        }
        await writeChunk(handle, value);
        bytes = nextBytes;
      }
      if (bytes === 0) throw new UploadValidationError("Uploaded file is empty", "EMPTY_FILE");
      if (length.supplied && bytes !== length.bytes) {
        throw new UploadValidationError("Upload length did not match Content-Length", "CONTENT_LENGTH_MISMATCH");
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(partialPath, sourcePath);
      return { id, sourcePath, filename, bytes, reservationBytes: length.bytes, reservationId };
    } catch (error) {
      // Do not wait on a client-controlled cancel implementation. Its rejection
      // is observed, but cleanup and the HTTP response remain bounded.
      if (reader) {
        try {
          void Promise.resolve(reader.cancel(error)).catch(() => undefined);
        } catch {
          // A custom reader may throw synchronously; file cleanup still runs.
        }
      }
      if (handle) {
        try { await handle.close(); } catch { /* cleanup below remains best effort */ }
      }
      const partialRemoved = await removePath(partialPath);
      const sourceRemoved = await removePath(sourcePath);
      if (reserved && partialRemoved && sourceRemoved) {
        try {
          await options.release(reservationId);
        } catch {
          // Keep the reservation if persistence cleanup failed; recovery can
          // reconcile it later without overstating available capacity.
        }
      }
      if (signal?.aborted) throw abortError();
      if (error instanceof ConverterError) throw error;
      throw storageError(error);
    }
  } catch (error) {
    // reserve() is an admission boundary. Its errors must retain their original
    // status/code instead of being rewritten as 507 storage failures.
    if (error instanceof ConverterError) throw error;
    throw error;
  }
}
