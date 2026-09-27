import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { extractInstrumentalFile } from "./instrumental.js";

test("separation publishes only instrumental WAV and cleans up failed or timed-out work", async () => {
  const directory = await mkdtemp("/tmp/instrumental-test-");
  const keys = ["FFMPEG_PATH", "DEMUCS_PATH", "DEMUCS_FIXTURE_MODE", "INSTRUMENTAL_TIMEOUT_SECONDS"];
  const saved = keys.map(key => process.env[key]);
  process.env.FFMPEG_PATH = resolve(import.meta.dir, "../test/fixtures/bin/ffmpeg");
  process.env.DEMUCS_PATH = resolve(import.meta.dir, "../test/fixtures/bin/demucs");
  try {
    const output = join(directory, "result.wav");
    await extractInstrumentalFile("fixture.source", output);
    expect(await Bun.file(output).text()).toContain("without vocals");
    expect(await readdir(directory)).toEqual(["result.wav"]);
    for (const mode of ["fail", "empty", "timeout"]) {
      process.env.DEMUCS_FIXTURE_MODE = mode;
      process.env.INSTRUMENTAL_TIMEOUT_SECONDS = "1";
      await expect(extractInstrumentalFile("fixture.source", join(directory, "failed.wav"))).rejects.toThrow();
      expect(await readdir(directory)).toEqual(["result.wav"]);
    }
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await rm(directory, { recursive: true, force: true });
  }
});
