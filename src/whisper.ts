import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import {
  NetworkTimeoutError,
  TranscriptionError,
  WhisperUnavailableError,
} from "./errors.js";

/**
 * Whisper models expect mono 16 kHz PCM. FFmpeg always resamples the source
 * audio to this layout before whisper-cli sees it.
 */
export const WHISPER_SAMPLE_RATE = 16_000;

export interface WhisperConfig {
  cliPath: string;
  modelPath: string;
  threads: number;
  language: string;
  timeoutSeconds: number;
  ffmpegTimeoutSeconds: number;
}

/**
 * Reads the speech-to-text configuration from the environment on every call so
 * callers and tests can vary it without re-importing the module. The default
 * model path resolves relative to this module so the server works from any
 * working directory.
 */
export function whisperConfig(): WhisperConfig {
  const threads = Number.parseInt(process.env.WHISPER_THREADS || "4", 10);
  const timeoutSeconds = Number.parseInt(process.env.WHISPER_TIMEOUT_SECONDS || "3600", 10);
  const ffmpegTimeoutSeconds = Number.parseInt(process.env.WHISPER_FFMPEG_TIMEOUT_SECONDS || "900", 10);
  return {
    cliPath: process.env.WHISPER_CLI_PATH || "whisper-cli",
    modelPath: process.env.WHISPER_MODEL_PATH || resolve(import.meta.dir, "../models/ggml-base.en.bin"),
    threads: Number.isInteger(threads) && threads > 0 ? threads : 4,
    language: process.env.WHISPER_LANG || "en",
    timeoutSeconds: Number.isInteger(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 3600,
    ffmpegTimeoutSeconds: Number.isInteger(ffmpegTimeoutSeconds) && ffmpegTimeoutSeconds > 0 ? ffmpegTimeoutSeconds : 900,
  };
}

export function ffmpegPath(): string {
  return process.env.FFMPEG_PATH || "ffmpeg";
}

/**
 * Spawns a speech-to-text subprocess with a bounded timeout, mirroring the
 * yt-dlp spawn discipline. A failed spawn means the component is missing.
 */
async function spawnProcess(
  executable: string,
  args: string[],
  timeoutSeconds: number,
  unavailableReason: string,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    // Pass the current environment explicitly: Bun snapshots the child
    // environment, so runtime process.env changes would otherwise not reach
    // whisper-cli or FFmpeg.
    proc = Bun.spawn([executable, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  } catch (error) {
    throw new WhisperUnavailableError(
      `${unavailableReason}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let timeoutId: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new NetworkTimeoutError(timeoutSeconds)), timeoutSeconds * 1000);
  });

  const procPromise = (async () => {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
      new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
      proc.exited,
    ]);
    return { stdout, stderr, exitCode };
  })();

  try {
    return await Promise.race([procPromise, timeoutPromise]);
  } catch (error) {
    proc.kill();
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Extracts a mono 16 kHz 16-bit PCM WAV from any audio/video file FFmpeg can
 * read. whisper-cli only accepts this layout reliably.
 */
export async function extractWav(
  inputPath: string,
  wavPath: string,
  config: WhisperConfig = whisperConfig(),
): Promise<void> {
  const result = await spawnProcess(
    ffmpegPath(),
    [
      "-y",
      "-hide_banner",
      "-loglevel", "error",
      "-i", inputPath,
      "-vn",
      "-ar", String(WHISPER_SAMPLE_RATE),
      "-ac", "1",
      "-c:a", "pcm_s16le",
      wavPath,
    ],
    config.ffmpegTimeoutSeconds,
    "ffmpeg could not be started",
  );

  if (result.exitCode !== 0) {
    throw new TranscriptionError(result.stderr.trim() || "audio extraction failed");
  }
  if (!(await isFile(wavPath))) {
    throw new TranscriptionError("audio extraction produced no WAV output");
  }
}

/**
 * Transcribes a 16 kHz mono WAV with whisper-cli and returns the plain-text
 * transcript. whisper-cli writes `-otxt` output next to the input file.
 */
export async function transcribeWav(
  wavPath: string,
  config: WhisperConfig = whisperConfig(),
): Promise<string> {
  if (!(await isFile(config.modelPath))) {
    throw new WhisperUnavailableError(
      `whisper model not found at ${config.modelPath}; run scripts/download-whisper-model.sh or set WHISPER_MODEL_PATH`,
    );
  }

  const result = await spawnProcess(
    config.cliPath,
    [
      "-m", config.modelPath,
      "-l", config.language,
      "-t", String(config.threads),
      "-f", wavPath,
      "-otxt",
      "-np",
    ],
    config.timeoutSeconds,
    "whisper-cli could not be started",
  );

  if (result.exitCode !== 0) {
    throw new TranscriptionError(result.stderr.trim() || "whisper-cli exited without producing a transcript");
  }

  const txtPath = `${wavPath}.txt`;
  if (!(await isFile(txtPath))) {
    throw new TranscriptionError("whisper-cli produced no transcript file");
  }
  const transcript = await Bun.file(txtPath).text();
  if (!transcript.trim()) {
    throw new TranscriptionError("whisper-cli produced an empty transcript");
  }
  return transcript;
}

/**
 * Transcribes any local media file, resampling it to a temporary WAV first.
 * Writes the plain-text transcript to `outputTxtPath` and returns it. The
 * temporary WAV is always removed.
 */
export async function transcribeAudioFile(
  inputPath: string,
  outputTxtPath: string,
  config: WhisperConfig = whisperConfig(),
): Promise<string> {
  const outputDirectory = dirname(outputTxtPath);
  await mkdir(outputDirectory, { recursive: true });
  const workingDirectory = await mkdtemp(`${outputDirectory}/.${basename(outputTxtPath)}-stt-`);

  try {
    const wavPath = `${workingDirectory}/audio.wav`;
    await extractWav(inputPath, wavPath, config);
    const transcript = await transcribeWav(wavPath, config);
    await Bun.write(outputTxtPath, transcript);
    return outputTxtPath;
  } finally {
    await rm(workingDirectory, { recursive: true, force: true });
  }
}

/** Extracts a local media file's first audio track as an MP3. */
export async function extractMp3File(inputPath: string, outputPath: string): Promise<string> {
  await mkdir(dirname(outputPath), { recursive: true });
  const result = await spawnProcess(ffmpegPath(), [
    "-y", "-hide_banner", "-loglevel", "error", "-i", inputPath,
    "-map", "0:a:0", "-vn", "-codec:a", "libmp3lame", "-q:a", "2", outputPath,
  ], whisperConfig().ffmpegTimeoutSeconds, "ffmpeg could not be started");
  if (result.exitCode !== 0) throw new TranscriptionError(result.stderr.trim() || "audio extraction failed");
  if (!(await isFile(outputPath)) || Bun.file(outputPath).size === 0) throw new TranscriptionError("audio extraction produced no MP3 output");
  return outputPath;
}
