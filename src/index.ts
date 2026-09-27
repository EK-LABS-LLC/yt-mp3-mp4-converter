import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { mkdir, readdir, rm, stat, statfs } from "node:fs/promises";
import { resolve, join } from "node:path";
import { downloadAudioForStt, getVideoInfo, convertToMp3, convertToMp4, downloadTranscript, pollTimeoutSeconds, sanitizeFilename } from "./yt-dlp.js";
import { convertRequestSchema, jobIdSchema } from "./schemas.js";
import { ConverterError } from "./errors.js";
import { transcribeAudioFile, extractMp3File, whisperConfig } from "./whisper.js";
import { JobStore, InsufficientStorageError, QueueFullError, type JobRecord } from "./jobs.js";
import { JobQueue } from "./queue.js";
import { extractInstrumentalFile } from "./instrumental.js";
import { streamUpload } from "./uploads.js";

export interface ServerConfig {
  downloadDir: string;
  stateDir: string;
  uploadDir: string;
  maxUploadBytes: number;
  maxPendingUploadBytes: number;
  minFreeDiskBytes: number;
  maxQueueSize: number;
  concurrency: number;
  jobTtlSeconds: number;
  cleanupIntervalSeconds: number;
  shutdownGraceSeconds: number;
  uploadIdleTimeoutSeconds: number;
  port: number;
}

export function readConfig(env = process.env): ServerConfig {
  const integer = (name: string, fallback: number, minimum = 1) => {
    const text = env[name];
    const value = text === undefined ? fallback : Number(text);
    if (!Number.isSafeInteger(value) || value < minimum || text === "") throw new Error(`${name} must be an integer >= ${minimum}`);
    return value;
  };
  const downloadDir = resolve(env.DOWNLOAD_DIR || "/tmp/yt-converter-downloads");
  const maxUploadBytes = integer("MAX_FILE_SIZE_MB", 500) * 1024 * 1024;
  const maxPendingUploadBytes = integer("MAX_PENDING_UPLOAD_BYTES", 4 * 1024 ** 3);
  if (!Number.isSafeInteger(maxUploadBytes) || maxPendingUploadBytes < maxUploadBytes) throw new Error("MAX_PENDING_UPLOAD_BYTES must fit one maximum upload");
  return {
    downloadDir, stateDir: resolve(env.STATE_DIR || join(downloadDir, ".state")),
    uploadDir: resolve(env.UPLOAD_DIR || join(downloadDir, ".uploads")),
    maxUploadBytes, maxPendingUploadBytes,
    minFreeDiskBytes: integer("MIN_FREE_DISK_BYTES", 2 * 1024 ** 3, 0),
    maxQueueSize: integer("MAX_QUEUE_SIZE", 10), concurrency: integer("JOB_CONCURRENCY", 2),
    jobTtlSeconds: integer("JOB_TTL_SECONDS", 259200), cleanupIntervalSeconds: integer("CLEANUP_INTERVAL_SECONDS", 3600),
    shutdownGraceSeconds: integer("SHUTDOWN_GRACE_SECONDS", 300, 0), uploadIdleTimeoutSeconds: integer("UPLOAD_IDLE_TIMEOUT_SECONDS", 60),
    port: integer("PORT", 3000, 0),
  };
}

const supportedExtensions = new Set([".mp3", ".mp4", ".m4a", ".wav", ".webm", ".mov", ".mkv", ".avi", ".mpeg", ".mpg", ".ogg", ".flac"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function errorResponse(error: unknown): Response {
  if (error instanceof ConverterError || error instanceof QueueFullError || error instanceof InsufficientStorageError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.statusCode, headers: error.statusCode === 429 ? { "Retry-After": "5" } : {} });
  }
  if (error instanceof SyntaxError) return Response.json({ error: "Invalid request body", code: "INVALID_JSON" }, { status: 400 });
  console.error("Request failed", error);
  return Response.json({ error: "The server could not persist this request", code: "INTERNAL_ERROR" }, { status: 500 });
}

export async function createApplication(overrides: Partial<ServerConfig> = {}) {
  const config = { ...readConfig(), ...overrides };
  if (overrides.downloadDir) {
    config.downloadDir = resolve(overrides.downloadDir);
    config.stateDir = resolve(overrides.stateDir || join(config.downloadDir, ".state"));
    config.uploadDir = resolve(overrides.uploadDir || join(config.downloadDir, ".uploads"));
  }
  if (config.maxPendingUploadBytes < config.maxUploadBytes) throw new Error("Pending upload budget must fit one upload");
  const workRoot = join(config.downloadDir, ".jobs");
  await Promise.all([config.downloadDir, config.uploadDir, workRoot].map(path => mkdir(path, { recursive: true })));
  const store = await JobStore.open({ stateDir: config.stateDir, maxQueueSize: config.maxQueueSize, maxPendingUploadBytes: config.maxPendingUploadBytes, jobTtlSeconds: config.jobTtlSeconds });
  let draining = false;
  let fatal: unknown;
  let storageCheckAvailable = true;
  let closed = false;
  let cleanupRunning: Promise<void> | undefined;
  const uploadControllers = new Set<AbortController>();
  const activeReservations = new Set<string>();
  const uploadTasks = new Set<Promise<unknown>>();
  const workPath = (id: string) => {
    if (!uuid.test(id)) throw new Error("Invalid owned job path");
    return join(workRoot, id);
  };
  const failClosed = (error: unknown) => { fatal = error; queue.stopDispatch(); console.error("Job storage failure; submissions stopped", error); };

  async function checkSpace() {
    let unwritten = 0;
    for (const reservation of store.reservations()) {
      let written = 0;
      try { written = (await stat(reservation.partialPath)).size; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      unwritten += Math.max(0, reservation.reservedBytes - written);
    }
    try {
      const space = await statfs(config.downloadDir, { bigint: true });
      if (space.bavail * space.bsize < BigInt(config.minFreeDiskBytes + unwritten)) throw new InsufficientStorageError("Not enough free disk space for uploads and processing");
    } catch (error) {
      if (["ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code || "")) {
        if (storageCheckAvailable) console.warn("statfs is unavailable; free-disk admission checks are disabled");
        storageCheckAvailable = false;
      } else { throw error instanceof InsufficientStorageError ? error : new InsufficientStorageError("Cannot verify free disk space"); }
    }
  }

  const queue = new JobQueue(store, {
    concurrency: config.concurrency, beforeWork: checkSpace, onFatal: failClosed,
    worker: async (job) => {
      const directory = workPath(job.id);
      await mkdir(directory, { recursive: true });
      const outputBase = join(directory, "result");
      if (job.kind === "upload") {
        if (job.format === "instrumental") return { outputPath: await extractInstrumentalFile(job.sourcePath!, `${outputBase}.wav`), filename: "instrumental.wav" };
        if (job.format === "mp3") return { outputPath: await extractMp3File(job.sourcePath!, `${outputBase}.mp3`), filename: "audio.mp3" };
        return { outputPath: await transcribeAudioFile(job.sourcePath!, `${outputBase}.txt`), filename: "transcript.txt" };
      }
      const videoInfo = await getVideoInfo(job.url!, { enforceFileSizeLimit: job.format === "mp3" || job.format === "instrumental", allowAnySource: job.format === "transcript" });
      if (job.format === "instrumental") {
        const source = await downloadAudioForStt(job.url!, join(directory, "source"));
        try {
          return { outputPath: await extractInstrumentalFile(source, `${outputBase}.wav`), videoInfo, filename: `${sanitizeFilename(videoInfo.title)}_instrumental.wav` };
        } finally { await rm(source, { force: true }); }
      }
      const outputPath = job.format === "mp3" ? await convertToMp3(job.url!, outputBase)
        : job.format === "mp4" ? await convertToMp4(job.url!, outputBase) : await downloadTranscript(job.url!, outputBase);
      return { outputPath, videoInfo, filename: sanitizeFilename(videoInfo.title) + (job.format === "transcript" ? ".txt" : `.${job.format}`) };
    },
  });

  async function discardReservation(id: string) {
    await rm(join(config.uploadDir, `${id}.part`), { force: true });
    await rm(join(config.uploadDir, `${id}.source`), { force: true });
    store.releaseUploadReservation(id);
  }

  async function cleanup() {
    if (cleanupRunning) return cleanupRunning;
    cleanupRunning = (async () => {
      for (const reservation of store.reservations()) {
        if (activeReservations.has(reservation.id)) continue;
        try {
          await rm(join(config.uploadDir, `${reservation.id}.part`), { force: true });
          await rm(join(config.uploadDir, `${reservation.id}.source`), { force: true });
        } catch (error) { console.warn("Reservation cleanup will be retried", reservation.id, error); continue; }
        store.releaseUploadReservation(reservation.id);
      }
      for (const job of store.allJobs()) {
        if (job.status !== "failed" && job.status !== "completed") continue;
        try {
          if (job.sourcePath) {
            if (job.sourcePath !== join(config.uploadDir, `${job.id}.source`)) throw new Error("Refusing unowned source cleanup");
            await rm(job.sourcePath, { force: true });
          }
          if (job.status === "failed" || (job.expiresAt !== undefined && job.expiresAt <= Date.now())) await rm(workPath(job.id), { recursive: true, force: true });
        } catch (error) { console.warn("Job cleanup will be retried", job.id, error); continue; }
        if (job.sourcePath) store.forgetSource(job.id);
        if (job.expiresAt !== undefined && job.expiresAt <= Date.now()) store.deleteExpired(job.id);
      }
    })().finally(() => { cleanupRunning = undefined; });
    return cleanupRunning;
  }

  try {
    store.recoverProcessing();
    for (const reservation of store.reservations()) await discardReservation(reservation.id);
    for (const job of store.allJobs()) {
      if (job.status === "queued" && job.kind === "upload" && (!job.sourcePath || !await Bun.file(job.sourcePath).exists())) {
        store.failQueuedMissingSource(job.id);
      }
    }
    const sourceOwners = new Set(store.allJobs().map(job => job.sourcePath));
    for (const filename of await readdir(config.uploadDir)) {
      if (/^[0-9a-f-]{36}\.(part|source)$/.test(filename) && !sourceOwners.has(join(config.uploadDir, filename))) await rm(join(config.uploadDir, filename), { force: true });
    }
    for (const filename of await readdir(workRoot)) {
      if (uuid.test(filename) && !store.get(filename)) await rm(workPath(filename), { recursive: true, force: true });
    }
    await cleanup();
  } catch (error) { store.close(); throw error; }

  const app = new Hono();
  app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "X-Upload-Filename"] }));
  app.use("*", logger());
  app.get("/", () => new Response(Bun.file("./public/index.html"), { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } }));
  app.get("/app.js", () => new Response(Bun.file("./public/app.js"), { headers: { "Content-Type": "application/javascript", "Cache-Control": "no-store" } }));

  app.get("/health", async (c) => {
    const settings = { maxUploadBytes: config.maxUploadBytes, storageCheckAvailable, draining, concurrency: config.concurrency };
    if (fatal) return c.json({ status: "unhealthy", error: "Job storage is unavailable", ...settings }, 503);
    try {
      const whisper = whisperConfig();
      const checks = await Promise.all([[process.env.YT_DLP_PATH || "yt-dlp", "--version"], [process.env.FFMPEG_PATH || "ffmpeg", "-version"], [whisper.cliPath, "--help"]].map(async args => {
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => proc.kill(), 5000);
        try {
          const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
          return { installed: code === 0, version: stdout.split("\n")[0] || "available" };
        } finally { clearTimeout(timer); }
      }));
      const model = Bun.file(whisper.modelPath);
      const modelReady = await model.exists() && model.size > 0;
      const healthy = !draining && checks.every(check => check.installed) && modelReady;
      return c.json({ status: healthy ? "healthy" : "unhealthy", ytDlp: checks[0], ffmpeg: checks[1], whisper: { installed: checks[2]!.installed, model: modelReady }, ...settings }, healthy ? 200 : 503);
    } catch { return c.json({ status: "unhealthy", error: "A required transcription tool is unavailable", ...settings }, 503); }
  });

  const unavailable = () => draining || fatal ? Response.json({ error: draining ? "The server is shutting down" : "Job storage is unavailable", code: draining ? "SHUTTING_DOWN" : "STORAGE_UNAVAILABLE" }, { status: 503, headers: { "Retry-After": "5" } }) : undefined;
  const acceptance = (job: JobRecord) => Response.json({ jobId: job.id, status: "queued", position: store.position(job.id), message: job.kind === "upload" && job.format === "transcript" ? "Transcription queued" : "Conversion queued", checkUrl: `/api/jobs/${job.id}`, pollTimeoutSeconds: pollTimeoutSeconds(job.format) }, { status: 202 });

  app.use("/api/convert", bodyLimit({ maxSize: 16384 }));
  app.post("/api/convert", async (c) => {
    const blocked = unavailable(); if (blocked) return blocked;
    try {
      const result = convertRequestSchema.safeParse(await c.req.json());
      if (!result.success) return c.json({ error: "Invalid request", code: "VALIDATION_ERROR", details: result.error.issues }, 400);
      const stopped = unavailable(); if (stopped) return stopped;
      await checkSpace();
      const afterCheck = unavailable(); if (afterCheck) return afterCheck;
      const job = store.enqueueUrl({ id: crypto.randomUUID(), kind: "url", format: result.data.format, url: result.data.url });
      const response = acceptance(job);
      queue.start();
      return response;
    } catch (error) {
      if (!(error instanceof ConverterError || error instanceof QueueFullError || error instanceof InsufficientStorageError || error instanceof SyntaxError)) failClosed(error);
      return errorResponse(error);
    }
  });

  app.post("/api/transcribe", async (c) => {
    const blocked = unavailable(); if (blocked) return blocked;
    const format = c.req.query("format") || "transcript";
    if (format !== "transcript" && format !== "mp3" && format !== "instrumental") return c.json({ error: "Upload format must be transcript, mp3, or instrumental", code: "VALIDATION_ERROR" }, 400);
    const controller = new AbortController();
    uploadControllers.add(controller);
    const task = (async () => {
      let upload: Awaited<ReturnType<typeof streamUpload>> | undefined;
      let reservationId: string | undefined;
      try {
        upload = await streamUpload(c.req.raw, {
          uploadDir: config.uploadDir, maxBytes: config.maxUploadBytes, idleTimeoutSeconds: config.uploadIdleTimeoutSeconds,
          supportedExtensions, signal: AbortSignal.any([controller.signal, c.req.raw.signal]),
          reserve: async (id, bytes, partialPath) => {
            if (draining) throw new ConverterError("The server is shutting down", "SHUTTING_DOWN", 503);
            store.reserveUpload({ id, reservedBytes: bytes, partialPath, createdAt: Date.now() });
            reservationId = id;
            activeReservations.add(id);
            try { await checkSpace(); } catch (error) { store.releaseUploadReservation(id); throw error; }
          },
          release: id => { store.releaseUploadReservation(id); },
        });
        if (draining || fatal) { await discardReservation(upload.id); return unavailable()!; }
        const job = store.enqueueUpload({ id: upload.id, kind: "upload", format, sourcePath: upload.sourcePath, sourceBytes: upload.bytes }, upload.reservationId);
        const response = acceptance(job);
        queue.start();
        return response;
      } catch (error) {
        if (upload) await discardReservation(upload.id);
        if (!(error instanceof ConverterError || error instanceof QueueFullError || error instanceof InsufficientStorageError)) failClosed(error);
        return errorResponse(error);
      } finally { uploadControllers.delete(controller); if (reservationId) activeReservations.delete(reservationId); }
    })();
    uploadTasks.add(task);
    try { return await task; } finally { uploadTasks.delete(task); }
  });

  const visibleJob = (id: string) => { const job = store.get(id); return job && (job.expiresAt === undefined || job.expiresAt > Date.now()) ? job : undefined; };
  app.get("/api/jobs/:jobId", c => {
    const validation = jobIdSchema.safeParse(c.req.param("jobId"));
    if (!validation.success) return c.json({ error: "Invalid job ID format", code: "VALIDATION_ERROR" }, 400);
    const job = visibleJob(validation.data);
    if (!job) return c.json({ error: "Job not found" }, 404);
    return c.json({ jobId: job.id, status: job.status, format: job.format, createdAt: job.createdAt, queuedAt: job.queuedAt,
      startedAt: job.startedAt ?? null, finishedAt: job.finishedAt ?? null, expiresAt: job.expiresAt ?? null, position: store.position(job.id),
      videoInfo: job.videoInfo, outputPath: job.outputPath, filename: job.filename, error: job.error, errorCode: job.errorCode });
  });
  app.get("/downloads/:jobId", async c => {
    const validation = jobIdSchema.safeParse(c.req.param("jobId"));
    if (!validation.success) return c.json({ error: "Invalid job ID format", code: "VALIDATION_ERROR" }, 400);
    const job = visibleJob(validation.data);
    if (!job) return c.json({ error: "Job not found" }, 404);
    if (job.status !== "completed") return c.json({ error: "Conversion not complete", status: job.status }, 400);
    if (!job.outputPath || !await Bun.file(job.outputPath).exists()) return c.json({ error: "File not available" }, 404);
    return new Response(Bun.file(job.outputPath), { headers: { "Content-Type": job.format === "instrumental" ? "audio/wav" : job.format === "mp3" ? "audio/mpeg" : job.format === "mp4" ? "video/mp4" : "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${job.filename}"` } });
  });

  const cleanupTimer = setInterval(() => { void cleanup().catch(failClosed); }, config.cleanupIntervalSeconds * 1000);
  cleanupTimer.unref();
  queue.start();
  function beginDrain() {
    draining = true;
    queue.stopDispatch();
    clearInterval(cleanupTimer);
    for (const controller of uploadControllers) controller.abort(new ConverterError("The server is shutting down", "SHUTTING_DOWN", 503));
  }
  async function close(graceSeconds = config.shutdownGraceSeconds) {
    if (closed) return true;
    beginDrain();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const allDone = Promise.all([queue.drain(graceSeconds), Promise.allSettled([...uploadTasks]), cleanupRunning]).then(([complete]) => complete);
    const done = await Promise.race([allDone, new Promise<false>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(false), graceSeconds * 1000); })]);
    if (timer) clearTimeout(timer);
    if (done) { store.close(); closed = true; }
    return done;
  }
  return { app, store, queue, config, beginDrain, close, cleanup };
}

export async function startServer(overrides: Partial<ServerConfig> = {}) {
  const runtime = await createApplication(overrides);
  const server = Bun.serve({ port: runtime.config.port, fetch: runtime.app.fetch, maxRequestBodySize: runtime.config.maxUploadBytes + 1024 * 1024, idleTimeout: 0 });
  return { ...runtime, server };
}

if (import.meta.main) {
  const runtime = await startServer();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    runtime.beginDrain();
    void runtime.close().then(() => { runtime.server.stop(true); process.exit(0); }, error => { console.error(error); runtime.server.stop(true); process.exit(1); });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  console.log(`Server started on ${runtime.server.url}`);
}
