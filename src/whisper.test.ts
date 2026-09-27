import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { extractMp3File, extractWav, transcribeAudioFile, transcribeWav, whisperConfig } from "./whisper";
import {
  NetworkTimeoutError,
  TranscriptionError,
  WhisperUnavailableError,
} from "./errors";

const FIXTURE_BIN_DIR = resolve(import.meta.dir, "../test/fixtures/bin");
const FIXTURE_WHISPER_CLI = resolve(FIXTURE_BIN_DIR, "whisper-cli");
const FIXTURE_FFMPEG = resolve(FIXTURE_BIN_DIR, "ffmpeg");
const FIXTURE_TRANSCRIPT = "This is the local speech-to-text fixture transcript.\nNo captions were needed.\n";

let tempDir = "";
let modelPath = "";
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  tempDir = await mkdtemp(resolve(tmpdir(), "yt-converter-whisper-"));
  modelPath = resolve(tempDir, "fixture-model.bin");
  await Bun.write(modelPath, "fixture-model-bytes");

  for (const key of [
    "WHISPER_CLI_PATH",
    "FFMPEG_PATH",
    "WHISPER_MODEL_PATH",
    "WHISPER_FIXTURE_MODE",
    "WHISPER_FIXTURE_ECHO_OUTPUT",
    "FFMPEG_FIXTURE_MODE",
    "WHISPER_FIXTURE_DELAY_MS",
  ] as const) {
    originalEnv[key] = process.env[key];
  }
  process.env.WHISPER_CLI_PATH = FIXTURE_WHISPER_CLI;
  process.env.FFMPEG_PATH = FIXTURE_FFMPEG;
  process.env.WHISPER_MODEL_PATH = modelPath;
  delete process.env.WHISPER_FIXTURE_MODE;
  delete process.env.WHISPER_FIXTURE_ECHO_OUTPUT;
  delete process.env.FFMPEG_FIXTURE_MODE;
});

afterAll(async () => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(tempDir, { recursive: true, force: true });
});

describe("whisper speech-to-text engine", () => {
  test("extracts a mono 16kHz WAV from an input media file", async () => {
    const input = resolve(tempDir, "source.mp4");
    await Bun.write(input, "fake-video-bytes");
    const wavPath = resolve(tempDir, "extracted.wav");

    await extractWav(input, wavPath);

    const bytes = new Uint8Array(await Bun.file(wavPath).arrayBuffer());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  });

  test("transcribes a WAV with whisper-cli and returns plain text", async () => {
    const wavPath = resolve(tempDir, "speech.wav");
    await Bun.write(wavPath, new Uint8Array([0x52, 0x49, 0x46, 0x46]));

    const transcript = await transcribeWav(wavPath);

    expect(transcript).toBe(FIXTURE_TRANSCRIPT);
  });

  test("transcribes any media file to the requested output path", async () => {
    const input = resolve(tempDir, "video.mp4");
    await Bun.write(input, "fake-video-bytes");
    const output = resolve(tempDir, "media-transcript.txt");

    const resultPath = await transcribeAudioFile(input, output);

    expect(resultPath).toBe(output);
    expect(await Bun.file(output).text()).toBe(FIXTURE_TRANSCRIPT);
  });

  test("cleans up the temporary WAV working directory", async () => {
    const input = resolve(tempDir, "cleanup.mp4");
    await Bun.write(input, "fake-video-bytes");
    const outputDir = resolve(tempDir, "cleanup-out");
    await mkdir(outputDir, { recursive: true });

    await transcribeAudioFile(input, resolve(outputDir, "result.txt"));

    expect((await readdir(outputDir)).filter((name) => name.includes("-stt-"))).toEqual([]);
  });

  test("rejects a missing whisper model as unavailable", async () => {
    const previous = process.env.WHISPER_MODEL_PATH;
    process.env.WHISPER_MODEL_PATH = resolve(tempDir, "does-not-exist.bin");
    try {
      await expect(transcribeWav(resolve(tempDir, "speech.wav"))).rejects.toBeInstanceOf(
        WhisperUnavailableError,
      );
    } finally {
      process.env.WHISPER_MODEL_PATH = previous;
    }
  });

  test("rejects a missing whisper-cli as unavailable", async () => {
    const previous = process.env.WHISPER_CLI_PATH;
    process.env.WHISPER_CLI_PATH = resolve(tempDir, "missing-whisper-cli");
    try {
      await expect(transcribeWav(resolve(tempDir, "speech.wav"))).rejects.toBeInstanceOf(
        WhisperUnavailableError,
      );
    } finally {
      process.env.WHISPER_CLI_PATH = previous;
    }
  });

  test("reports a whisper-cli failure as a transcription error", async () => {
    const previous = process.env.WHISPER_FIXTURE_MODE;
    process.env.WHISPER_FIXTURE_MODE = "fail";
    try {
      await expect(transcribeWav(resolve(tempDir, "speech.wav"))).rejects.toBeInstanceOf(
        TranscriptionError,
      );
    } finally {
      process.env.WHISPER_FIXTURE_MODE = previous;
    }
  });

  test("reports a missing transcript file as a transcription error", async () => {
    const previous = process.env.WHISPER_FIXTURE_MODE;
    process.env.WHISPER_FIXTURE_MODE = "no-file";
    try {
      await expect(transcribeWav(resolve(tempDir, "speech-no-file.wav"))).rejects.toBeInstanceOf(
        TranscriptionError,
      );
    } finally {
      process.env.WHISPER_FIXTURE_MODE = previous;
    }
  });

  test("reports an empty transcript as a transcription error", async () => {
    const previous = process.env.WHISPER_FIXTURE_MODE;
    process.env.WHISPER_FIXTURE_MODE = "empty";
    try {
      await expect(transcribeWav(resolve(tempDir, "speech-empty.wav"))).rejects.toBeInstanceOf(
        TranscriptionError,
      );
    } finally {
      process.env.WHISPER_FIXTURE_MODE = previous;
    }
  });

  test("reports an ffmpeg failure as a transcription error", async () => {
    const previous = process.env.FFMPEG_FIXTURE_MODE;
    process.env.FFMPEG_FIXTURE_MODE = "fail";
    try {
      await expect(
        extractWav(resolve(tempDir, "source.mp4"), resolve(tempDir, "out.wav")),
      ).rejects.toBeInstanceOf(TranscriptionError);
    } finally {
      process.env.FFMPEG_FIXTURE_MODE = previous;
    }
  });

  test("echoes the input path as the transcript when asked", async () => {
    const previous = process.env.WHISPER_FIXTURE_ECHO_OUTPUT;
    process.env.WHISPER_FIXTURE_ECHO_OUTPUT = "1";
    try {
      const result = await transcribeWav(resolve(tempDir, "speech.wav"));
      expect(result.trim()).toContain("speech.wav");
    } finally {
      process.env.WHISPER_FIXTURE_ECHO_OUTPUT = previous;
    }
  });

  test("kills whisper-cli and reports a timeout when it outlives its budget", async () => {
    const wavPath = resolve(tempDir, "slow.wav");
    await Bun.write(wavPath, new Uint8Array([0x52, 0x49, 0x46, 0x46]));
    process.env.WHISPER_FIXTURE_DELAY_MS = "5000";
    try {
      await expect(transcribeWav(wavPath, { ...whisperConfig(), timeoutSeconds: 1 })).rejects.toBeInstanceOf(
        NetworkTimeoutError,
      );
      expect(await Bun.file(`${wavPath}.txt`).exists()).toBe(false);
    } finally {
      delete process.env.WHISPER_FIXTURE_DELAY_MS;
    }
  });

  test("reports an extraction that writes no regular WAV file", async () => {
    await expect(extractWav(resolve(tempDir, "source.mp4"), "/dev/null")).rejects.toThrow(
      "audio extraction produced no WAV output",
    );
  });

  test("extracts an MP3 from a local media file", async () => {
    const input = resolve(tempDir, "song.mp4");
    await Bun.write(input, "fake-video-bytes");
    const output = resolve(tempDir, "mp3-out", "audio.mp3");

    expect(await extractMp3File(input, output)).toBe(output);
    expect(await Bun.file(output).text()).toStartWith("ID3");
  });

  test("reports MP3 extraction failures as transcription errors", async () => {
    const input = resolve(tempDir, "song.mp4");
    process.env.FFMPEG_FIXTURE_MODE = "fail";
    try {
      await expect(extractMp3File(input, resolve(tempDir, "failed.mp3"))).rejects.toThrow(
        "fixture ffmpeg failed to extract audio",
      );
    } finally {
      delete process.env.FFMPEG_FIXTURE_MODE;
    }
    await expect(extractMp3File(input, "/dev/null")).rejects.toThrow("audio extraction produced no MP3 output");
  });
});
