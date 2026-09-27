import { rm } from "node:fs/promises";
import { JobStore, type JobRecord, type NewJob } from "./jobs.js";

export interface JobWorkResult {
  outputPath: string;
  filename: string;
  videoInfo?: unknown;
}

export type JobWorker = (job: JobRecord) => Promise<JobWorkResult>;
export type BeforeWork = (job: JobRecord) => Promise<void> | void;
export type QueueFatalHandler = (error: unknown) => void | Promise<void>;

export interface JobQueueOptions {
  concurrency: number;
  worker: JobWorker;
  beforeWork?: BeforeWork;
  onFatal?: QueueFatalHandler;
}

export class JobQueue {
  private readonly store: JobStore;
  private readonly worker: JobWorker;
  private readonly beforeWork?: BeforeWork;
  private readonly onFatal?: QueueFatalHandler;
  private readonly concurrency: number;
  private active = 0;
  private dispatching = false;
  private started = false;
  private fatal = false;
  private waiters: Array<() => void> = [];

  constructor(store: JobStore, options: JobQueueOptions) {
    this.store = store;
    this.worker = options.worker;
    this.beforeWork = options.beforeWork;
    this.onFatal = options.onFatal;
    this.concurrency = Math.max(1, Math.floor(options.concurrency));
  }

  start(): void {
    if (this.fatal) return;
    this.started = true;
    this.pump();
  }

  stopDispatch(): void {
    this.started = false;
  }

  enqueueUrl(job: NewJob): JobRecord {
    const record = this.store.enqueueUrl(job);
    this.pump();
    return record;
  }

  enqueueUpload(job: NewJob, reservationId: string): JobRecord {
    const record = this.store.enqueueUpload(job, reservationId);
    this.pump();
    return record;
  }

  activeCount(): number {
    return this.active;
  }

  isDraining(): boolean {
    return !this.started;
  }

  async drain(graceSeconds: number): Promise<boolean> {
    this.stopDispatch();
    if (this.active === 0) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    let resolveDrain!: (completed: boolean) => void;
    const finished = new Promise<boolean>((resolve) => {
      resolveDrain = resolve;
      this.waiters.push(() => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(true);
      });
    });
    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveDrain(false);
    }, Math.max(0, graceSeconds) * 1000);
    return finished;
  }

  private pump(): void {
    if (this.dispatching || !this.started || this.fatal) return;
    this.dispatching = true;
    try {
      while (this.started && !this.fatal && this.active < this.concurrency) {
        let job: JobRecord | undefined;
        try {
          job = this.store.claimNext();
        } catch (error) {
          this.reportFatal(error);
          break;
        }
        if (!job) break;
        this.active++;
        void this.run(job);
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async run(job: JobRecord): Promise<void> {
    try {
      let result: JobWorkResult;
      try {
        await this.beforeWork?.(job);
        result = await this.worker(job);
      } catch (error) {
        const sourceReleased = await this.removeSource(job);
        try {
          this.store.fail(job.id, {
            error: error instanceof Error ? error.message : String(error),
            errorCode: this.errorCode(error),
            sourceReleased,
          });
        } catch (persistenceError) {
          this.reportFatal(persistenceError);
        }
        return;
      }

      const sourceReleased = await this.removeSource(job);
      try {
        // The output is already published by the worker. If this transition
        // fails, report a fatal store error and leave the output untouched.
        this.store.complete(job.id, { ...result, sourceReleased });
      } catch (persistenceError) {
        this.reportFatal(persistenceError);
      }
    } finally {
      this.active--;
      if (this.active === 0) {
        const waiters = this.waiters.splice(0);
        for (const resolve of waiters) resolve();
      }
      this.pump();
    }
  }

  private async removeSource(job: JobRecord): Promise<boolean> {
    if (!job.sourcePath) return true;
    try {
      await rm(job.sourcePath, { force: false });
      return true;
    } catch (error) {
      return this.isMissing(error) ? true : false;
    }
  }

  private errorCode(error: unknown): string {
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      return error.code;
    }
    return "UNKNOWN_ERROR";
  }

  private isMissing(error: unknown): boolean {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
  }

  private reportFatal(error: unknown): void {
    if (this.fatal) return;
    this.fatal = true;
    this.started = false;
    try {
      const result = this.onFatal?.(error);
      if (result && typeof result.then === "function") {
        void result.catch(() => undefined);
      }
    } catch {
      // A fatal callback must not turn a contained persistence failure into an
      // unhandled rejection.
    }
  }
}
