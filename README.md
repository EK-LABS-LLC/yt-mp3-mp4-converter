# YouTube MP3, MP4, and Transcript Downloader

Download YouTube media from a browser or CLI, and give AI clients direct access to YouTube metadata and transcripts through MCP.

The web app and CLI provide three outputs:

- MP3 audio
- MP4 video
- Plain-text English transcripts from YouTube captions, with local speech-to-text (whisper.cpp) fallback for videos without captions

> Transcripts come from existing YouTube captions when available, and fall back to local, on-device speech-to-text (whisper.cpp) for videos without captions — including non-YouTube URLs and local video files. It is free and runs locally: no API keys, no per-minute cost.

| Surface | Capabilities |
| --- | --- |
| Browser/API | MP3, MP4, and transcript downloads |
| CLI | MP3, MP4, and transcript downloads |
| MCP | Video metadata and transcript context for AI clients |

## Quick start

```bash
git clone https://github.com/theworksofvon/yt-mp3-mp4-converter.git
cd yt-mp3-mp4-converter
./scripts/setup.sh
bun run start
```

Open <http://localhost:3000>, paste a YouTube URL, choose an output, and select **Download**.

`setup.sh` is safe to run again. It installs or upgrades to Bun 1.4.2 or newer, detects existing tools, installs only missing requirements, installs the locked Bun dependencies, and runs the local checks. On macOS it also installs whisper.cpp and downloads the default speech-to-text model; on other platforms speech-to-text is optional. Automatic system-package installation supports:

- macOS, bootstrapping Homebrew when needed
- Debian/Ubuntu with `apt-get`
- Fedora/RHEL with `dnf`
- Arch Linux with `pacman`

Verify an existing machine without installing anything:

```bash
./scripts/setup.sh --check
```

On Windows, use WSL for the same setup command, or manually install [Bun](https://bun.sh), [yt-dlp](https://github.com/yt-dlp/yt-dlp), and [FFmpeg](https://ffmpeg.org/download.html).

## Command line

```bash
bun run transcript "https://www.youtube.com/watch?v=VIDEO_ID"
bun run transcript "https://vimeo.com/123"
bun run transcript "/path/to/local/video.mp4"
bun run mp3 "https://www.youtube.com/watch?v=VIDEO_ID"
bun run mp4 "https://www.youtube.com/watch?v=VIDEO_ID"
```

`bun run transcript` accepts any URL or a local media file. When no captions are available, the audio is transcribed locally by whisper.cpp. Omit the URL to enter it interactively. Files are saved under `./downloads` unless `CLIENT_DOWNLOAD_DIR` is set:

```bash
CLIENT_DOWNLOAD_DIR=/tmp/youtube-downloads bun run transcript "https://youtu.be/VIDEO_ID"
```

## MCP for Codex, Claude, Cursor, and other clients

The repository includes a local stdio MCP server powered by the same transcript implementation as the web app and CLI. It is model-provider independent; the MCP host only needs to be able to launch a local command.

Run setup first, then register the stable launcher with your client.

Codex:

```bash
codex mcp add youtube-transcript -- "$(pwd)/scripts/run-mcp.sh"
codex mcp list
```

Claude Code:

```bash
claude mcp add --transport stdio --scope user youtube-transcript -- "$(pwd)/scripts/run-mcp.sh"
claude mcp list
```

Generic MCP JSON:

```json
{
  "mcpServers": {
    "youtube-transcript": {
      "command": "/absolute/path/to/yt-mp3-mp4-converter/scripts/run-mcp.sh",
      "args": [],
      "env": {
        "MCP_TRANSCRIPT_DIR": "/absolute/path/to/your/transcript-cache"
      }
    }
  }
}
```

The server exposes:

| Tool | Purpose |
| --- | --- |
| `get_youtube_video_info` | Return a video's title, uploader, duration, upload date, thumbnail, and ID. |
| `get_youtube_transcript` | Return cleaned English caption text, optionally preceded by video metadata. |

See [docs/MCP.md](docs/MCP.md) for package installation, provider configuration, verification, limitations, and troubleshooting.

## How the shared implementation works

```text
Browser/API ─┐
CLI ─────────┼─→ src/yt-dlp.ts → yt-dlp → YouTube
MCP ─────────┘                     │
                                  └─→ FFmpeg for web/CLI MP3 and MP4 only
```

Transcript downloads ask `yt-dlp` for English manual and auto-generated captions, prefer English caption files, remove VTT/SRT timing and markup, and save plain text. When no captions are available, FFmpeg extracts mono 16 kHz audio and whisper.cpp transcribes it locally, so transcripts also work for non-YouTube URLs and local video files.

## Configuration

| Variable | Default | Used by |
| --- | --- | --- |
| `PORT` | `3000` | Web server port |
| `DOWNLOAD_DIR` | `/tmp/yt-converter-downloads` | Web/API output storage |
| `CLIENT_DOWNLOAD_DIR` | `./downloads` | CLI output storage |
| `MCP_TRANSCRIPT_DIR` | Per-user directory in the OS temporary directory | MCP transcript cache |
| `MAX_FILE_SIZE_MB` | `500` | MP3 size limit |

On POSIX systems, including WSL, the MCP transcript cache is restricted to owner-only permissions and rejected if it is a symlink or owned by another UID. Native Windows has no UID or POSIX-mode enforcement here and relies on directory ACLs; WSL is the recommended Windows path.

## Speech-to-text (whisper.cpp)

Videos without captions (and non-YouTube URLs or local files) are transcribed locally by [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No audio leaves your machine, and there are no API keys or per-minute costs. When whisper-cli or its model is missing, transcription of caption-less videos fails with a clear message.

| Variable | Default | Used by |
| --- | --- | --- |
| `WHISPER_CLI_PATH` | `whisper-cli` | Path to the whisper-cli binary |
| `WHISPER_MODEL_PATH` | `models/ggml-base.en.bin` | Path to the model file |
| `WHISPER_MODEL` | `base.en` | Model name used by `scripts/download-whisper-model.sh` |
| `WHISPER_MODEL_DIR` | `models` | Directory where the download script places the model |
| `WHISPER_LANG` | `en` | Source language for transcription |
| `WHISPER_THREADS` | `4` | CPU threads for transcription |
| `WHISPER_TIMEOUT_SECONDS` | `3600` | Timeout for a single transcription |

`scripts/download-whisper-model.sh` fetches the model (default `base.en`, about 142 MB) from Hugging Face. `setup.sh` runs it automatically once whisper-cli is installed.

## Docker

Docker includes Bun, `yt-dlp`, FFmpeg, and `whisper-cli` (with the base model):

```bash
docker compose up --build
```

Then open <http://localhost:3000>. The compose file persists downloads in `./downloads`.

## API

Start a job:

```http
POST /api/convert
Content-Type: application/json

{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "format": "transcript"
}
```

`format` accepts `mp3`, `mp4`, or `transcript`. The response contains a `jobId`.

```text
GET /api/jobs/:jobId     Check status
GET /downloads/:jobId    Download a completed output
GET /health              Check yt-dlp and FFmpeg availability
```

## Development

```bash
bun install --frozen-lockfile
bun run check
```

`bun run check` typechecks the project, runs deterministic unit/protocol/API/CLI tests, writes LCOV output, and enforces at least 90% line and function coverage across loaded source modules. These tests use a local `yt-dlp` fixture and do not contact YouTube.

For a first-time contributor setup including Chromium, or to run the browser journey afterward:

```bash
./scripts/setup.sh --with-browser
# or, after normal setup:
bunx playwright install chromium
bun run check:all
```

The browser test starts the real HTTP server, submits the form, waits for a transcript job, verifies the downloaded file, and checks the inaccessible-video error path. CI also builds the production Docker image. A scheduled workflow runs one small live metadata/transcript smoke test weekly so upstream YouTube or `yt-dlp` changes are detected without making pull-request checks flaky.

Manual live checks contact YouTube and must be enabled explicitly:

```bash
bun run test:live
bun run test:integration
```

`test:live` checks metadata and transcript retrieval for one small public video. `test:integration` is the heavier legacy media-download suite.

CI runs typechecking, the coverage gate, API/CLI/MCP end-to-end tests, the Chromium browser journey, shell syntax checks, a Docker build, and an npm package dry run. The npm release workflow repeats the release-critical checks after changes reach `main`; npm trusted publishing must be configured for `.github/workflows/release.yml` before the first release.

## License

MIT
