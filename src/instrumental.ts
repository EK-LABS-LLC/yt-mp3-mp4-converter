import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ConverterError, NetworkTimeoutError } from "./errors.js";
import { ffmpegPath } from "./whisper.js";

export function instrumentalTimeoutSeconds(): number {
  const value = Number(process.env.INSTRUMENTAL_TIMEOUT_SECONDS || 7200);
  return Number.isSafeInteger(value) && value > 0 ? value : 7200;
}

export async function extractInstrumentalFile(inputPath: string, outputPath: string): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  const directory = await mkdtemp(join(dirname(outputPath), ".instrumental-"));
  try {
    // Uploaded sources have no media extension. Normalize the first audio track
    // without lossy encoding so Demucs can decode audio and video consistently.
    const audio = join(directory, "audio.wav");
    await run([ffmpegPath(), "-y", "-hide_banner", "-loglevel", "error", "-i", inputPath,
      "-map", "0:a:0", "-vn", "-ar", "44100", "-ac", "2", "-c:a", "pcm_f32le", audio], 900);
    await run([process.env.DEMUCS_PATH || resolve(import.meta.dir, "../.venv-instrumental/bin/demucs"),
      "--two-stems", "vocals", "-n", "htdemucs", "-d", "cpu", "-j", "1", "--int24",
      "-o", directory, audio], instrumentalTimeoutSeconds());
    const result = join(directory, "htdemucs", "audio", "no_vocals.wav");
    if (!await Bun.file(result).exists() || Bun.file(result).size <= 44) {
      throw new ConverterError("Vocal separation produced no instrumental audio", "SEPARATION_FAILED", 500);
    }
    await rename(result, outputPath);
    return outputPath;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function run(command: string[], timeoutSeconds: number): Promise<void> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(command, { stdout: "ignore", stderr: "pipe", env: process.env });
  } catch {
    throw new ConverterError("Instrumental processing tools are unavailable. Run scripts/setup-instrumental.sh and verify FFmpeg is installed.", "SEPARATION_UNAVAILABLE", 503);
  }
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill(); }, timeoutSeconds * 1000);
  // Progress output can be large for long songs; retain only a diagnostic tail.
  const stderr = (async () => {
    let tail = "";
    const decoder = new TextDecoder();
    for await (const chunk of proc.stderr as ReadableStream<Uint8Array>) {
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-4000);
    }
    return tail;
  })();
  try {
    const [code, detail] = await Promise.all([proc.exited, stderr]);
    if (timedOut) throw new NetworkTimeoutError(timeoutSeconds);
    if (code !== 0) throw new ConverterError(`Instrumental processing failed: ${detail.trim() || "audio could not be processed"}`, "SEPARATION_FAILED", 500);
  } finally { clearTimeout(timer); }
}
