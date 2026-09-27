import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export type JobStatus = "queued" | "processing" | "completed" | "failed";
export type JobKind = "upload" | "url";
export type JobFormat = "mp3" | "mp4" | "transcript" | "instrumental";

export interface JobRecord {
  id: string;
  kind: JobKind;
  status: JobStatus;
  format: JobFormat;
  createdAt: number;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  expiresAt?: number;
  queueSequence: number;
  sourcePath?: string;
  sourceBytes?: number;
  url?: string;
  videoInfo?: unknown;
  outputPath?: string;
  filename?: string;
  error?: string;
  errorCode?: string;
}

export interface UploadReservation {
  id: string;
  reservedBytes: number;
  partialPath: string;
  createdAt: number;
}

export interface JobStoreOptions {
  stateDir: string;
  maxQueueSize: number;
  maxPendingUploadBytes: number;
  jobTtlSeconds: number;
}

export interface NewJob {
  id: string;
  kind: JobKind;
  format: JobFormat;
  sourcePath?: string;
  sourceBytes?: number;
  url?: string;
  createdAt?: number;
}

export interface CompletedJob {
  outputPath: string;
  filename: string;
  videoInfo?: unknown;
  now?: number;
  sourceReleased: boolean;
}

export interface FailedJob {
  error: string;
  errorCode: string;
  now?: number;
  sourceReleased: boolean;
}

export class QueueFullError extends Error {
  readonly code = "QUEUE_FULL";
  readonly statusCode = 429;

  constructor() {
    super("The conversion queue is full");
    this.name = "QueueFullError";
  }
}

export class InsufficientStorageError extends Error {
  readonly code = "INSUFFICIENT_STORAGE";
  readonly statusCode = 507;

  constructor(message = "The server does not have enough storage available") {
    super(message);
    this.name = "InsufficientStorageError";
  }
}

const SCHEMA_VERSION = 2;
const PROCESS_INTERRUPTED = "PROCESS_INTERRUPTED";
const SOURCE_MISSING = "SOURCE_MISSING";

function optionalNumber(value: number | null): number | undefined {
  return value === null ? undefined : value;
}

function parseVideoInfo(value: string | null): unknown {
  if (!value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export class JobStore {
  readonly db: Database;
  readonly options: JobStoreOptions;

  constructor(options: JobStoreOptions) {
    this.options = options;
    this.db = new Database(resolve(options.stateDir, "jobs.sqlite"));
    try {
      // WAL improves reader/writer behavior, while FULL is required here because
      // a queued job or reservation must survive a successful HTTP response.
      this.db.exec("PRAGMA journal_mode = WAL;");
      this.db.exec("PRAGMA synchronous = FULL;");
      this.db.exec("PRAGMA foreign_keys = ON;");
      this.migrate();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  static async open(options: JobStoreOptions): Promise<JobStore> {
    await mkdir(options.stateDir, { recursive: true });
    return new JobStore(options);
  }

  close(): void {
    this.db.close();
  }

  get(id: string): JobRecord | undefined {
    const row = this.db.query("SELECT * FROM jobs WHERE id = ?1").get(id) as JobRow | null;
    return row ? this.toJob(row) : undefined;
  }

  allJobs(): JobRecord[] {
    return this.rowsToJobs(this.db.query("SELECT * FROM jobs ORDER BY queue_sequence").all() as JobRow[]);
  }

  listJobs(): JobRecord[] {
    return this.allJobs();
  }

  listAll(): JobRecord[] {
    return this.allJobs();
  }

  queuedJobs(): JobRecord[] {
    return this.rowsToJobs(this.db.query(
      "SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_sequence",
    ).all() as JobRow[]);
  }

  terminalJobsRetainingSources(): JobRecord[] {
    return this.rowsToJobs(this.db.query(
      "SELECT * FROM jobs WHERE status IN ('completed', 'failed') AND source_path IS NOT NULL ORDER BY queue_sequence",
    ).all() as JobRow[]);
  }

  listTerminalJobsWithSources(): JobRecord[] {
    return this.terminalJobsRetainingSources();
  }

  position(id: string): number | null {
    const row = this.db.query(
      "SELECT status, queue_sequence FROM jobs WHERE id = ?1",
    ).get(id) as { status: JobStatus; queue_sequence: number } | null;
    if (!row || row.status !== "queued") return null;
    const count = this.db.query(
      "SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued' AND queue_sequence <= ?1",
    ).get(row.queue_sequence) as { count: number };
    return Number(count.count);
  }

  pendingUploadBytes(): number {
    const jobs = this.db.query(
      "SELECT COALESCE(SUM(source_bytes), 0) AS bytes FROM jobs WHERE source_bytes IS NOT NULL",
    ).get() as { bytes: number };
    const reservations = this.db.query(
      "SELECT COALESCE(SUM(reserved_bytes), 0) AS bytes FROM upload_reservations",
    ).get() as { bytes: number };
    return Number(jobs.bytes) + Number(reservations.bytes);
  }

  waitingCount(): number {
    const jobs = this.db.query("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'").get() as { count: number };
    const reservations = this.db.query("SELECT COUNT(*) AS count FROM upload_reservations").get() as { count: number };
    return Number(jobs.count) + Number(reservations.count);
  }

  reserveUpload(reservation: UploadReservation): void {
    if (!Number.isSafeInteger(reservation.reservedBytes) || reservation.reservedBytes <= 0) {
      throw new InsufficientStorageError("Upload reservation must be a positive byte count");
    }

    const transaction = this.db.transaction(() => {
      if (this.waitingCount() >= this.options.maxQueueSize) throw new QueueFullError();
      if (this.pendingUploadBytes() + reservation.reservedBytes > this.options.maxPendingUploadBytes) {
        throw new InsufficientStorageError("The pending upload byte budget is exhausted");
      }
      this.db.query(
        "INSERT INTO upload_reservations (id, reserved_bytes, partial_path, created_at) VALUES (?1, ?2, ?3, ?4)",
      ).run(reservation.id, reservation.reservedBytes, reservation.partialPath, reservation.createdAt);
    });
    transaction();
  }

  getUploadReservation(id: string): UploadReservation | undefined {
    const row = this.db.query("SELECT * FROM upload_reservations WHERE id = ?1").get(id) as ReservationRow | null;
    return row ? this.toReservation(row) : undefined;
  }

  releaseUploadReservation(id: string): UploadReservation | undefined {
    const row = this.db.query("SELECT * FROM upload_reservations WHERE id = ?1").get(id) as ReservationRow | null;
    if (!row) return undefined;
    this.db.query("DELETE FROM upload_reservations WHERE id = ?1").run(id);
    return this.toReservation(row);
  }

  reservations(): UploadReservation[] {
    return (this.db.query("SELECT * FROM upload_reservations ORDER BY created_at, id").all() as ReservationRow[])
      .map((row) => this.toReservation(row));
  }

  enqueueUpload(job: NewJob, reservationId: string): JobRecord {
    if (job.kind !== "upload") throw new Error("Upload jobs must have kind 'upload'");
    if (job.id !== reservationId) throw new Error("Upload job and reservation ids must match");
    const sourceBytes = job.sourceBytes;
    if (!job.sourcePath || typeof sourceBytes !== "number" || !Number.isSafeInteger(sourceBytes) || sourceBytes <= 0) {
      throw new Error("Upload jobs require a positive source byte count and source path");
    }

    const transaction = this.db.transaction(() => {
      const reservation = this.db.query("SELECT * FROM upload_reservations WHERE id = ?1").get(reservationId) as ReservationRow | null;
      if (!reservation) throw new Error("Upload reservation no longer exists");
      if (sourceBytes > reservation.reserved_bytes) {
        throw new InsufficientStorageError("The uploaded source is larger than its reservation");
      }
      const record = this.insertJob(job);
      this.db.query("DELETE FROM upload_reservations WHERE id = ?1").run(reservationId);
      return record;
    });
    return transaction() as JobRecord;
  }

  enqueueUrl(job: NewJob): JobRecord {
    if (job.kind !== "url") throw new Error("URL jobs must have kind 'url'");
    const transaction = this.db.transaction(() => {
      if (this.waitingCount() >= this.options.maxQueueSize) throw new QueueFullError();
      return this.insertJob(job);
    });
    return transaction() as JobRecord;
  }

  claimNext(): JobRecord | undefined {
    const transaction = this.db.transaction(() => {
      const row = this.db.query(
        "SELECT * FROM jobs WHERE status = 'queued' ORDER BY queue_sequence LIMIT 1",
      ).get() as JobRow | null;
      if (!row) return undefined;
      const now = Date.now();
      const result = this.db.query(
        "UPDATE jobs SET status = 'processing', started_at = ?1 WHERE id = ?2 AND status = 'queued'",
      ).run(now, row.id);
      if (result.changes !== 1) return undefined;
      row.status = "processing";
      row.started_at = now;
      return this.toJob(row);
    });
    return transaction() as JobRecord | undefined;
  }

  complete(id: string, result: CompletedJob): JobRecord {
    const now = result.now ?? Date.now();
    const expiresAt = now + this.options.jobTtlSeconds * 1000;
    const sourceFields = result.sourceReleased ? ", source_path = NULL, source_bytes = NULL" : "";
    const videoInfo = result.videoInfo === undefined ? null : JSON.stringify(result.videoInfo);
    const query = `UPDATE jobs SET status = 'completed', finished_at = ?1, expires_at = ?2, output_path = ?3, filename = ?4, video_info = COALESCE(?5, video_info)${sourceFields} WHERE id = ?6 AND status = 'processing'`;
    const changed = this.db.query(query).run(now, expiresAt, result.outputPath, result.filename, videoInfo, id).changes;
    if (changed !== 1) throw new Error("Job completion transition failed");
    return this.get(id)!;
  }

  fail(id: string, failure: FailedJob): JobRecord {
    const now = failure.now ?? Date.now();
    const expiresAt = now + this.options.jobTtlSeconds * 1000;
    const sourceFields = failure.sourceReleased ? ", source_path = NULL, source_bytes = NULL" : "";
    const query = `UPDATE jobs SET status = 'failed', finished_at = ?1, expires_at = ?2, error = ?3, error_code = ?4${sourceFields} WHERE id = ?5 AND status = 'processing'`;
    const changed = this.db.query(query).run(now, expiresAt, failure.error, failure.errorCode, id).changes;
    if (changed !== 1) throw new Error("Job failure transition failed");
    return this.get(id)!;
  }

  recoverProcessing(now = Date.now()): JobRecord[] {
    const transaction = this.db.transaction(() => {
      const ids = this.db.query("SELECT id FROM jobs WHERE status = 'processing'").all() as Array<{ id: string }>;
      const expiresAt = now + this.options.jobTtlSeconds * 1000;
      for (const row of ids) {
        this.db.query(
          "UPDATE jobs SET status = 'failed', finished_at = ?1, expires_at = ?2, error = ?3, error_code = ?4 WHERE id = ?5 AND status = 'processing'",
        ).run(now, expiresAt, "The process stopped while this job was running", PROCESS_INTERRUPTED, row.id);
      }
      return ids.map(({ id }) => this.get(id)!);
    });
    return transaction() as JobRecord[];
  }

  failQueuedMissingSource(id: string, now = Date.now()): JobRecord | undefined {
    const expiresAt = now + this.options.jobTtlSeconds * 1000;
    const changed = this.db.query(
      "UPDATE jobs SET status = 'failed', finished_at = ?1, expires_at = ?2, error = ?3, error_code = ?4, source_path = NULL, source_bytes = NULL WHERE id = ?5 AND status = 'queued' AND kind = 'upload'",
    ).run(now, expiresAt, "The uploaded source file is missing", SOURCE_MISSING, id).changes;
    return changed === 1 ? this.get(id) : undefined;
  }

  forgetSource(id: string): JobRecord | undefined {
    const changed = this.db.query(
      "UPDATE jobs SET source_path = NULL, source_bytes = NULL WHERE id = ?1 AND source_path IS NOT NULL",
    ).run(id).changes;
    return changed === 1 ? this.get(id) : undefined;
  }

  forgetJobSource(id: string): JobRecord | undefined {
    return this.forgetSource(id);
  }

  expired(now = Date.now()): JobRecord[] {
    return this.rowsToJobs(this.db.query(
      "SELECT * FROM jobs WHERE status IN ('completed', 'failed') AND expires_at IS NOT NULL AND expires_at <= ?1 ORDER BY queue_sequence",
    ).all(now) as JobRow[]);
  }

  deleteExpired(id: string, now = Date.now()): boolean {
    // Source accounting must be explicitly released after filesystem cleanup.
    const result = this.db.query(
      "DELETE FROM jobs WHERE id = ?1 AND status IN ('completed', 'failed') AND expires_at IS NOT NULL AND expires_at <= ?2 AND source_path IS NULL",
    ).run(id, now);
    return result.changes === 1;
  }

  private migrate(): void {
    const row = this.db.query("PRAGMA user_version").get() as { user_version: number };
    if (![0, 1, SCHEMA_VERSION].includes(row.user_version)) {
      throw new Error(`Unsupported jobs database schema version ${row.user_version}`);
    }

    if (row.user_version === 1) {
      this.db.transaction(() => {
        const table = this.db.query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'jobs'").get() as { sql: string };
        this.db.exec(table.sql.replace(/^CREATE TABLE\s+(?:IF NOT EXISTS\s+)?["`]?jobs["`]?/i, "CREATE TABLE jobs_v2").replace("'transcript'", "'transcript', 'instrumental'"));
        this.db.exec(`
          INSERT INTO jobs_v2 SELECT * FROM jobs;
          DROP TABLE jobs;
          ALTER TABLE jobs_v2 RENAME TO jobs;
          CREATE INDEX jobs_status_sequence ON jobs(status, queue_sequence);
          CREATE INDEX jobs_expiration ON jobs(expires_at);
          PRAGMA user_version = 2;
        `);
      })();
    }

    if (row.user_version === 0) {
      const transaction = this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS jobs (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK (kind IN ('upload', 'url')),
            status TEXT NOT NULL CHECK (status IN ('queued', 'processing', 'completed', 'failed')),
            format TEXT NOT NULL CHECK (format IN ('mp3', 'mp4', 'transcript', 'instrumental')),
            created_at INTEGER NOT NULL,
            queued_at INTEGER NOT NULL,
            started_at INTEGER,
            finished_at INTEGER,
            expires_at INTEGER,
            queue_sequence INTEGER NOT NULL UNIQUE,
            source_path TEXT,
            source_bytes INTEGER,
            url TEXT,
            video_info TEXT,
            output_path TEXT,
            filename TEXT,
            error TEXT,
            error_code TEXT
          );
          CREATE INDEX IF NOT EXISTS jobs_status_sequence ON jobs(status, queue_sequence);
          CREATE INDEX IF NOT EXISTS jobs_expiration ON jobs(expires_at);
          CREATE TABLE IF NOT EXISTS upload_reservations (
            id TEXT PRIMARY KEY,
            reserved_bytes INTEGER NOT NULL,
            partial_path TEXT NOT NULL,
            created_at INTEGER NOT NULL
          );
        `);
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
      });
      transaction();
    }
  }

  private insertJob(job: NewJob): JobRecord {
    const now = job.createdAt ?? Date.now();
    const sequence = this.db.query("SELECT COALESCE(MAX(queue_sequence), 0) + 1 AS sequence FROM jobs").get() as { sequence: number };
    this.db.query(`
      INSERT INTO jobs (id, kind, status, format, created_at, queued_at, queue_sequence, source_path, source_bytes, url)
      VALUES (?1, ?2, 'queued', ?3, ?4, ?4, ?5, ?6, ?7, ?8)
    `).run(job.id, job.kind, job.format, now, Number(sequence.sequence), job.sourcePath ?? null, job.sourceBytes ?? null, job.url ?? null);
    return this.get(job.id)!;
  }

  private rowsToJobs(rows: JobRow[]): JobRecord[] {
    return rows.map((row) => this.toJob(row));
  }

  private toJob(row: JobRow): JobRecord {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      format: row.format,
      createdAt: row.created_at,
      queuedAt: row.queued_at,
      startedAt: optionalNumber(row.started_at),
      finishedAt: optionalNumber(row.finished_at),
      expiresAt: optionalNumber(row.expires_at),
      queueSequence: row.queue_sequence,
      sourcePath: row.source_path ?? undefined,
      sourceBytes: row.source_bytes ?? undefined,
      url: row.url ?? undefined,
      videoInfo: parseVideoInfo(row.video_info),
      outputPath: row.output_path ?? undefined,
      filename: row.filename ?? undefined,
      error: row.error ?? undefined,
      errorCode: row.error_code ?? undefined,
    };
  }

  private toReservation(row: ReservationRow): UploadReservation {
    return { id: row.id, reservedBytes: row.reserved_bytes, partialPath: row.partial_path, createdAt: row.created_at };
  }
}

interface JobRow {
  id: string;
  kind: JobKind;
  status: JobStatus;
  format: JobFormat;
  created_at: number;
  queued_at: number;
  started_at: number | null;
  finished_at: number | null;
  expires_at: number | null;
  queue_sequence: number;
  source_path: string | null;
  source_bytes: number | null;
  url: string | null;
  video_info: string | null;
  output_path: string | null;
  filename: string | null;
  error: string | null;
  error_code: string | null;
}

interface ReservationRow {
  id: string;
  reserved_bytes: number;
  partial_path: string;
  created_at: number;
}
