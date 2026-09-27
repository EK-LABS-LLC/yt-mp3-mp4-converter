import { defineConfig, devices } from "@playwright/test";
import { delimiter, resolve } from "node:path";

const fixtureBin = resolve(import.meta.dirname, "test/fixtures/bin");
const port = 41_731;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "bun run src/index.ts",
    url: `http://127.0.0.1:${port}/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
    env: {
      ...process.env,
      PATH: `${fixtureBin}${delimiter}${process.env.PATH || ""}`,
      YT_DLP_PATH: resolve(fixtureBin, "yt-dlp"),
      WHISPER_CLI_PATH: resolve(fixtureBin, "whisper-cli"),
      DEMUCS_PATH: resolve(fixtureBin, "demucs"),
      FFMPEG_PATH: resolve(fixtureBin, "ffmpeg"),
      WHISPER_MODEL_PATH: resolve(fixtureBin, "fixture-model.bin"),
      DOWNLOAD_DIR: resolve(import.meta.dirname, "test-results/server-downloads"),
      PORT: String(port),
    },
  },
});
