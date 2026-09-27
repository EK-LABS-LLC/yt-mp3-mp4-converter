# Changelog

All notable changes from Ralph Wiggum Loop sessions.

## [Unreleased]

### Added
- Instrumental WAV downloads remove vocals locally from YouTube links or uploaded audio/video using Demucs, with queued processing and a configurable timeout
- Local video uploads can extract MP3 audio, with two jobs processing simultaneously by default and additional jobs queued
- Browser upload transcription streams audio and video to disk with configurable upload limits, local Whisper processing, queue position updates, and transcript download
- Durable shared FIFO jobs survive restarts, retain completed downloads for three days by default, and bound waiting jobs and upload storage
- Graceful shutdown drains active work, preserves queued jobs, and reports interrupted processing after restart
- `get_video_transcript` MCP tool that transcribes any video URL, falling back to local speech-to-text when captions are unavailable
- Web app and `POST /api/convert` transcript jobs accept any video URL, not just YouTube; the CLI accepts local media file paths
- Local speech-to-text (whisper.cpp) fallback for videos without captions: `scripts/download-whisper-model.sh` fetches the default model, `scripts/setup.sh` installs whisper-cli on macOS and downloads the model, and the Docker image builds whisper-cli from source and bakes in the base model
- Tests for URL conversion in every format, health checks, fail-closed storage errors, startup recovery, periodic cleanup, whisper timeouts, and MP3 extraction, so `bun run check` meets the per-file coverage thresholds
- TypeScript behavior contracts, Rust migration architecture, complete test migration inventory, and deterministic CLI/MCP/HTTP golden parity fixtures
- **Enhanced input sanitization** (`src/yt-dlp.ts`, `src/schemas.ts`)
  - Comprehensive command injection detection with 30+ pattern checks
  - `sanitizeString()` - removes control characters while preserving newlines/tabs
  - `sanitizeAndValidateYouTubeUrl()` - multi-layer URL validation with error messages
  - Enhanced `sanitizeFilename()` - detects malicious shell metacharacters in filenames
  - New `src/schemas.ts` with Zod validation schemas for all API inputs
  - `convertRequestSchema` - validates convert endpoint payloads with security checks
  - `jobIdSchema` - validates job ID format to prevent injection
  - `Sanitizer` utility class for string, filename, and URL sanitization
  - URL-encoded attack detection (%3b, %7c, %60, etc.)
  - Escape sequence detection (hex, unicode, octal)
  - yt-dlp specific flag detection (--exec, --postprocessor-args, etc.)
- **Comprehensive test coverage** (`src/schemas.test.ts`, `src/yt-dlp.test.ts`)
  - 48 tests covering all sanitization functions
  - Tests for enhanced command injection patterns
  - Tests for Zod schema validation
  - Tests for filename sanitization edge cases
  - URL validation tests with malicious inputs

### Changed
- The web workspace puts local transcription and MP3 extraction first, with drag-and-drop uploads, a responsive neutral design, and video links available in a secondary panel
- Docker whisper builds use portable static CPU settings with bounded parallelism; the model download is mandatory and health checks verify the HTTP API, transcription tools, model, ffmpeg, and yt-dlp
- Updated `src/index.ts` to use new Zod schemas from `src/schemas.ts`
- Enhanced job ID validation in `/api/jobs/:jobId` endpoint
- Enhanced job ID validation in `/downloads/:jobId` endpoint
- Transcript, metadata, and MP4 requests are no longer refused because of the reported audio file size; the size limit now applies to MP3 downloads, which are the requests that actually fetch that stream
- `/api/convert` returns `pollTimeoutSeconds`, and the web page enforces that server-provided deadline across polling delays and stalled responses instead of giving up after a fixed two minutes, so long MP4 conversions can finish
- Numeric caption lines that are spoken text, such as a year, survive transcript cleanup; only real SRT cue indexes are dropped
- `scripts/setup.sh` requires Bun 1.3.6 or newer, no longer accepts `1.3.6` prereleases for that stable minimum, upgrades an outdated Bun during normal setup, reports the version clearly under `--check`, and leaves shell options unchanged when sourced
- `scripts/setup.sh` no longer overrides tools already on the caller's `PATH`

### Security
- Transcript downloads use isolated per-invocation caption directories, so concurrent or stale caption files at the same requested output path cannot be consumed by another request
- The default MCP transcript cache is a private per-user directory rather than a shared, predictable path in the system temporary directory; each tool call publishes into a new private child directory, and POSIX cache roots are restricted to owner-only access and rejected if they are symlinks or owned by another user
- Command injection detection now covers:
  - Shell metacharacters (`;`, `|`, `` ` ``, `$`, `(`, `)`)
  - Double operators (`||`, `&&`)
  - Command substitution (`$(cmd)`, `` `cmd` ``)
  - Variable expansion (`${VAR}`)
  - Escape sequences (`\xNN`, `\uXXXX`, `\0NNN`)
  - File redirects (`>`, `<`, `2>&1`)
  - Directory traversal (`..`, `../`, `..\`)
  - URL-encoded attacks
  - yt-dlp specific dangerous flags
- URL validation includes:
  - Length limits (500 chars max)
  - Video ID format validation (11 chars, alphanumeric with - and _)
  - Protocol validation with auto-addition of https://
- Filename sanitization now:
  - Returns "sanitized_filename" for malicious inputs
  - Removes control characters (0x00-0x1F)
  - Removes path traversal patterns
  - Limits filename length to 200 characters

### Added
- **MP4 conversion test suite** (`src/yt-dlp.test.ts`)
  - Tests for standard 1080p video conversion to MP4
  - Tests for longer video MP4 conversion
  - Tests for YouTube Shorts to MP4 conversion
  - MP4 file validation using magic bytes (ftyp box check)
  - Automatic test skipping when yt-dlp is not available
- **MP3 conversion test suite** (`src/yt-dlp.test.ts`)
  - URL validation tests for various YouTube URL formats (watch, shorts, youtu.be)
  - Command injection detection tests
  - Filename sanitization tests
  - Job ID generation tests
  - Video info extraction tests (require yt-dlp to be installed)
  - MP3 conversion tests for short and long videos (require yt-dlp to be installed)
  - Input sanitization tests
  - Automatic test skipping when yt-dlp is not available
- Fixed missing `ConverterError` import in `src/yt-dlp.ts`

### Added
- Installed `hono` v4.11.4 - lightweight web framework for Bun
- Installed `zod` v4.3.5 - schema validation library
- Basic Hono server setup (`src/index.ts`)
  - CORS configuration for frontend access
  - Logger middleware for development
  - Root route with API documentation
  - Health check endpoint (`GET /health`) that verifies yt-dlp and ffmpeg installation
  - Port configuration via `PORT` environment variable (default: 3000)
- **yt-dlp wrapper module** (`src/yt-dlp.ts`)
  - `isValidYouTubeUrl()` - YouTube URL validation using regex with command injection detection
  - `hasCommandInjection()` - detect shell metacharacters and injection patterns
  - `getVideoInfo(url)` - extract video metadata without downloading
  - `convertToMp3(url, outputPath)` - download and extract audio to MP3
  - `convertToMp4(url, outputPath)` - download video to MP4
  - `generateJobId()` - unique job ID generation
  - `sanitizeFilename()` - filename sanitization for safe file storage
- **Error handling module** (`src/errors.ts`)
  - `ConverterError` - base error class with HTTP status codes
  - `InvalidUrlError` - for invalid YouTube URLs (400)
  - `VideoNotAccessibleError` - for private/deleted/restricted videos (400)
  - `NetworkTimeoutError` - for request timeouts (504)
  - `ConversionError` - for conversion failures (500)
  - `FileSizeError` - for files exceeding max size (413)
  - `RateLimitError` - for rate limiting (429)
  - `parseYtDlpError()` - parse yt-dlp stderr into specific error types
- **Conversion API** (`POST /api/convert`)
  - Accepts `{ url, format }` request body
  - URL validation using regex (YouTube URLs only)
  - Format validation (mp3 or mp4) using Zod
  - Returns job ID for async conversion tracking
  - Enhanced error responses with error codes and proper HTTP status codes
- **Job status endpoint** (`GET /api/jobs/:jobId`)
  - Check conversion progress
  - Returns status, video info, and file path when complete
  - Includes error code when conversion fails
- **File download endpoint** (`GET /downloads/:jobId`)
  - Serves converted files with proper Content-Type headers
  - Forces download with Content-Disposition header
- In-memory job storage for tracking conversions
- Configurable download directory via `DOWNLOAD_DIR` environment variable
- Configurable max file size via `MAX_FILE_SIZE_MB` environment variable (default: 500MB)
- Request timeout handling (300s for conversions, 60s for video info)

### Changed
- All yt-dlp operations now use array-style arguments to prevent command injection
- Error responses now include structured error codes for client-side handling
- Job failures now include error codes for easier debugging

### Security
- Added command injection detection for user inputs
- URLs are validated against shell metacharacters before processing
- All yt-dlp invocations use separate arguments instead of string concatenation

### Added
- **Docker support** for containerized deployment
  - `Dockerfile` - Multi-stage build using oven/bun:1 base image
    - Installs yt-dlp via pip
    - Installs ffmpeg for audio/video processing
    - Copies `src`, `public`, and builds TypeScript to `./dist`
    - Production-optimized with health checks
  - `docker-compose.yml` - Easy local development and deployment
    - Port mapping 3000:3000
    - Volume mount for persistent downloads
    - Health check configuration
  - `.dockerignore` - Optimized Docker build context

### Added
- **Frontend UI** (`public/index.html`)
  - Clean, responsive HTML interface
  - YouTube URL input field with validation
  - Format selection (MP3/MP4) via radio buttons
  - Real-time status display with loading spinner
  - Success/error message display
  - Download link on conversion completion

- **Client-side JavaScript** (`public/app.js`)
  - Form submission handling
  - Async job polling for conversion status
  - Automatic download trigger on completion
  - YouTube URL validation
  - Error handling with user-friendly messages

- Static file serving for frontend assets
  - `GET /` - serves the HTML interface
  - `GET /app.js` - serves the client-side JavaScript

### Added
- **Environment variable example** (`.env.example`)
  - `PORT` - Server port (default: 3000)
  - `MAX_FILE_SIZE_MB` - Maximum file size for downloads (default: 500)
  - `DOWNLOAD_DIR` - Temporary download storage directory

### Notes
- System dependencies `yt-dlp` and `ffmpeg` need to be installed manually:
  - `pip install yt-dlp` (or `pip3 install --user yt-dlp`)
  - `apt-get install ffmpeg` (or equivalent for your system)
- Using Bun's native server instead of @hono/node-server
- Job storage is in-memory (consider Redis/database for production)
- Docker images support multi-architecture builds (AMD64/ARM) for Raspberry Pi compatibility
