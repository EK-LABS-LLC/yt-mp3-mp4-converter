import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("a user can download a transcript and see actionable failures", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", {
    name: "Your video. In words.",
  })).toBeVisible();

  await page.locator("#urlDetails").evaluate(element => { element.setAttribute("open", ""); });
  await page.getByLabel("Video URL").fill(
    "https://www.youtube.com/watch?v=fixture12345",
  );
  await page.locator('label[for="transcript"]').click();
  await expect(page.getByLabel("Transcript", { exact: true })).toBeChecked();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();

  const status = page.locator("#status");
  await expect(status).toContainText("Transcript ready!", { timeout: 10_000 });
  await expect(status.getByRole("link", { name: "Download Transcript" })).toBeVisible();

  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("Fixture_Video_E2E_Test.txt");
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, "utf8")).toContain(
    "shared download path works",
  );

  await page.locator("#urlDetails").evaluate(element => { element.setAttribute("open", ""); });
  await page.getByLabel("Video URL").fill(
    "https://www.youtube.com/watch?v=private-video",
  );
  await page.getByRole("button", { name: "Download" }).click();
  await expect(status).toHaveClass(/error/);
  await expect(status).toContainText("private");
});

test("a user can transcribe a caption-less video via local speech-to-text", async ({ page }) => {
  await page.goto("/");

  await page.locator("#urlDetails").evaluate(element => { element.setAttribute("open", ""); });
  await page.getByLabel("Video URL").fill(
    "https://www.youtube.com/watch?v=no-captions",
  );
  await page.locator('label[for="transcript"]').click();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download" }).click();

  const status = page.locator("#status");
  await expect(status).toContainText("Transcript ready!", { timeout: 10_000 });

  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).not.toBeNull();
  expect(await readFile(downloadPath!, "utf8")).toContain("No captions were needed");
});

test("a user can upload media and download its local transcript", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Transcribe a local video or audio file").setInputFiles({
    name: "meeting.mp4",
    mimeType: "video/mp4",
    buffer: Buffer.from("fixture media"),
  });
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();

  const status = page.locator("#status");
  await expect(status).toContainText("Transcript ready!", { timeout: 10_000 });
  const link = status.getByRole("link", { name: "Download Transcript" });
  await expect(link).toBeVisible();
  const href = await link.getAttribute("href");
  expect(href).not.toBeNull();
  const response = await page.request.get(href!);
  expect(await response.text()).toContain("local speech-to-text fixture transcript");
});

test("gives up at the deadline the server advertises", async ({ page }) => {
  const jobId = "1700000000000-abcdef12";
  let jobStatusRequested = false;

  await page.route("**/api/convert", (route) =>
    route.fulfill({
      status: 202,
      json: {
        jobId,
        status: "processing",
        message: "Conversion started",
        checkUrl: `/api/jobs/${jobId}`,
        pollTimeoutSeconds: 1,
      },
    }),
  );
  await page.route(`**/api/jobs/${jobId}`, async (route) => {
    jobStatusRequested = true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    await route.fulfill({ json: { jobId, status: "processing" } }).catch(() => {});
  });

  await page.goto("/");
  await page.locator("#urlDetails").evaluate(element => { element.setAttribute("open", ""); });
  await page.getByLabel("Video URL").fill(
    "https://www.youtube.com/watch?v=fixture12345",
  );
  await page.getByRole("button", { name: "Download" }).click();

  const status = page.locator("#status");
  await expect(status).toContainText("Conversion timed out", { timeout: 15_000 });
  await expect(status).toHaveClass(/error/);
  expect(jobStatusRequested).toBe(true);
});

test("uses the advertised upload limit even when health is unavailable", async ({ page }) => {
  await page.route("**/health", route => route.fulfill({ status: 503, json: { maxUploadBytes: 1024 * 1024 } }));
  await page.goto("/");
  await expect(page.locator("#uploadHelp")).toContainText("Up to 1 MB");
  await page.getByLabel("Transcribe a local video or audio file").setInputFiles({ name: "large.mp4", mimeType: "video/mp4", buffer: Buffer.alloc(1024 * 1024 + 1) });
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator("#status")).toContainText("no larger than 1 MB");
});

test("queue wait and a temporary disconnect do not consume processing time", async ({ page }) => {
  const jobId = "persisted-test-job";
  let attempts = 0;
  await page.route("**/api/transcribe", async route => {
    expect(route.request().headers()["content-type"]).toBe("application/octet-stream");
    expect(route.request().headers()["x-upload-filename"]).toBe("my%20meeting.mp4");
    await route.fulfill({ status: 202, json: { jobId, status: "queued", pollTimeoutSeconds: 1 } });
  });
  await page.route(`**/api/jobs/${jobId}`, async route => {
    attempts++;
    if (attempts === 2) { await route.abort("connectionreset"); return; }
    await route.fulfill({ json: attempts < 4 ? { status: "queued", position: 2 } : { status: "completed", filename: "transcript.txt", format: "transcript" } });
  });
  await page.goto("/");
  await page.getByLabel("Transcribe a local video or audio file").setInputFiles({ name: "my meeting.mp4", mimeType: "video/mp4", buffer: Buffer.from("media") });
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Queued — position 2");
  await expect(page.locator("#status")).toContainText("Transcript ready!", { timeout: 10000 });
});

test("shows unknown upload limits without blocking uploads", async ({ page }) => {
  await page.route("**/health", route => route.fulfill({ status: 503, json: { status: "unhealthy" } }));
  await page.goto("/");
  await expect(page.locator("#uploadHelp")).toContainText("Limit unavailable");
  await expect(page.getByRole("button", { name: "Transcribe", exact: true })).toBeEnabled();
});


test("extracts MP3 from an uploaded video and keeps the chosen file removable", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("#fileChip")).toBeHidden();
  await page.locator('label[for="taskMp3"]').click();
  await page.getByLabel("Transcribe a local video or audio file").setInputFiles({ name: "recording.mp4", mimeType: "video/mp4", buffer: Buffer.from("fixture video") });
  await expect(page.locator("#fileName")).toHaveText("recording.mp4");
  await expect(page.locator("#dropzone")).toBeHidden();
  await page.getByRole("button", { name: "Extract MP3", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Conversion complete!", { timeout: 10000 });
  const link = page.getByRole("link", { name: "Download MP3", exact: true });
  const download = await page.request.get((await link.getAttribute("href"))!);
  expect(download.headers()["content-type"]).toBe("audio/mpeg");
  expect((await download.body()).length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Remove selected file" }).click();
  await expect(page.locator("#fileChip")).toBeHidden();
  await expect(page.locator("#dropzone")).toBeVisible();
});

test("accepts drag and drop and locks task controls while a job runs", async ({ page }) => {
  await page.route("**/api/transcribe", route => route.fulfill({ status: 202, json: { jobId: "slow-job", status: "queued", pollTimeoutSeconds: 60 } }));
  await page.route("**/api/jobs/slow-job", route => route.fulfill({ json: { status: "queued", position: 2 } }));
  await page.goto("/");
  const transfer = await page.evaluateHandle('(() => { const data = new DataTransfer(); data.items.add(new File(["media"], "dropped.mp4", { type: "video/mp4" })); return data; })()');
  await page.locator("#dropzone").dispatchEvent("drop", { dataTransfer: transfer });
  await expect(page.locator("#fileName")).toHaveText("dropped.mp4");
  await page.getByRole("button", { name: "Transcribe", exact: true }).click();
  await expect(page.locator("#status")).toContainText("Queued — position 2");
  await expect(page.locator("#taskMp3")).toBeDisabled();
  await expect(page.locator("#uploadFile")).toBeDisabled();
  await expect(page.getByRole("button", { name: "Remove selected file" })).toBeDisabled();
});

for (const source of ['upload', 'youtube']) {
  test(`a user can create an instrumental from ${source}`, async ({ page }) => {
    await page.goto('/');
    await page.locator('label[for="taskInstrumental"]').click();
    if (source === 'upload') {
      await page.locator('#uploadFile').setInputFiles({ name: 'song.flac', mimeType: 'audio/flac', buffer: Buffer.from('fixture song') });
    } else {
      await page.locator('#urlDetails').evaluate(element => element.setAttribute('open', ''));
      await page.getByLabel('Video URL').fill('https://www.youtube.com/watch?v=fixture12345');
      await expect(page.locator('#instrumental')).toBeChecked();
    }
    await expect(page.locator('#instrumentalHelp')).toBeVisible();
    await page.locator('#submitBtn').click();
    const link = page.getByRole('link', { name: 'Download Instrumental WAV' });
    await expect(link).toBeVisible({ timeout: 15000 });
    const response = await page.request.get((await link.getAttribute('href'))!);
    expect(response.headers()['content-type']).toBe('audio/wav');
    expect(response.headers()['content-disposition']).toContain('instrumental.wav');
    expect(await response.text()).toContain('without vocals');
  });
}
