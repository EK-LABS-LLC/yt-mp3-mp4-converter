import {
  ConverterError,
  InvalidUrlError,
  VideoNotAccessibleError,
  NetworkTimeoutError,
  ConversionError,
  FileSizeError,
  RateLimitError,
  TranscriptionError,
  WhisperUnavailableError,
  parseYtDlpError,
} from "./errors.js";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { isIP } from "node:net";
import { basename, dirname, extname, resolve } from "node:path";
import { instrumentalTimeoutSeconds } from "./instrumental.js";
import { transcribeAudioFile } from "./whisper.js";

// YouTube URL validation regex
export const YOUTUBE_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/;

// Maximum file size in bytes (default 500MB, can be overridden via env)
const MAX_FILE_SIZE = Number.parseInt(process.env.MAX_FILE_SIZE_MB || "500", 10) * 1024 * 1024;

// yt-dlp invocation budgets, in seconds. Callers that wait on a job need these
// to derive a deadline that outlasts the work the server is willing to do.
export const METADATA_TIMEOUT_SECONDS = 60;

// Caption download is quick even for long videos; the transcript budget is
// dominated by the speech-to-text fallback, which runs roughly in real time.
export const CAPTIONS_TIMEOUT_SECONDS = 120;
export const AUDIO_DOWNLOAD_TIMEOUT_SECONDS = 900;

export const FORMAT_TIMEOUT_SECONDS: Record<OutputFormat, number> = {
  mp3: 300,
  mp4: 900,
  // One full speech-to-text pass plus its setup steps fits inside two hours;
  // the poll deadline below derives from this so clients do not give up early.
  transcript: 7200,
};

/**
 * Longest a conversion job can legitimately take: metadata lookup plus the
 * per-format download budget.
 */
export function pollTimeoutSeconds(format: OutputFormat | "instrumental"): number {
  if (format === "instrumental") return METADATA_TIMEOUT_SECONDS + AUDIO_DOWNLOAD_TIMEOUT_SECONDS + 900 + instrumentalTimeoutSeconds();
  return METADATA_TIMEOUT_SECONDS + FORMAT_TIMEOUT_SECONDS[format];
}

export interface VideoInfo {
  id: string;
  title: string;
  duration: number;
  thumbnail: string;
  uploader: string;
  upload_date: string;
}

export interface ConversionOptions {
  url: string;
  format: OutputFormat;
  outputDir: string;
}

export type OutputFormat = "mp3" | "mp4" | "transcript";

export interface ConversionResult {
  jobId: string;
  outputPath: string;
  filename: string;
}

/**
 * Checks for potential command injection patterns in input
 *
 * This function detects various command injection attempts including:
 * - Shell metacharacters (semicolon, ampersand, pipe, backtick, dollar sign, parentheses)
 * - Directory traversal (..)
 * - Variable expansion (${VAR})
 * - Hex escape sequences (\xNN)
 * - Command substitution via backticks or $()
 * - Pipe chains and logical operators
 * - Newline characters (command separators)
 * - Tab characters (potential whitespace exploits)
 * - Null bytes
 * - Unicode escape sequences (\uXXXX)
 * - Backslash escapes
 */
export function hasCommandInjection(input: string): boolean {
  // Early exit for empty input
  if (!input || input.length === 0) {
    return false;
  }

  // Remove valid protocol prefixes first (https://, http://)
  // But only from the beginning to avoid false positives
  const sanitized = input.replace(/^https?:\/\//i, "");

  // Enhanced injection patterns - comprehensive security checks
  // Note: We need to be careful not to flag valid URL characters like &, =, ?
  const injectionPatterns: RegExp[] = [
    // Shell metacharacters and command separators (but allow & in URLs)
    /[;|`$()]/,
    /\|\|/,
    /;/,
    /\n/,
    /\r/,
    /\t/,
    /\x00/,

    // Directory traversal
    /\.\./,
    /\.\.\//,
    /\.\.\\/,

    // Variable and command substitution
    /\$\{/,
    /\$\(/,
    /`/,
    /\$\{.*\}/,

    // Escape sequences
    /\\x[0-9a-f]{2}/i,
    /\\u[0-9a-f]{4}/i,
    /\\U[0-9a-f]{8}/i,
    /\\0[0-7]{2}/,
    /\\[nrtbvf]/,

    // File system operations
    />\//,
    /<\//,
    /2>&1/,
    /\/dev\//,

    // Command injection patterns specific to yt-dlp/youtube-dl
    /--exec/,
    /--postprocessor-args/,
    /--concat/,
    /--print-movement/,

    // Base64 encoded commands (common attack vector)
    /base64\s*-d/i,
    /echo.*\|.*base64/i,

    // Common attack strings
    /bash\s+-/i,
    /sh\s+-/i,
    /eval\s*\(/i,
    /exec\s*\(/i,
    /system\s*\(/i,
    /passthru\s*\(/i,

    // URL-encoded attacks
    /%3b/i,
    /%7c/i,
    /%60/i,
    /%24%28/i,

    // Double ampersand (but allow & as single char in URL query params)
    /&&/,

    // File operations (excluding valid URL patterns)
    /["']/,
  ];

  // Check all patterns
  for (const pattern of injectionPatterns) {
    if (pattern.test(sanitized)) {
      return true;
    }
  }

  // Additional check: multiple consecutive special characters that could form injection
  // E.g., "||||", ";;;;", ">>>", "<<<"
  if (/[;|<>]{3,}/.test(sanitized)) {
    return true;
  }

  return false;
}

/**
 * Validates a YouTube URL
 */
export function isValidYouTubeUrl(url: string): boolean {
  // First check for command injection attempts
  if (hasCommandInjection(url)) {
    return false;
  }
  return YOUTUBE_REGEX.test(url);
}

/**
 * Spawn yt-dlp with timeout and error handling
 */
async function spawnYtDlp(args: string[], timeoutSeconds: number = 300): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const ytDlpExecutable = process.env.YT_DLP_PATH || "yt-dlp";
  const proc = Bun.spawn([ytDlpExecutable, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Set up timeout
  let timeoutId: Timer | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new NetworkTimeoutError(timeoutSeconds)), timeoutSeconds * 1000);
  });

  // Wait for process completion and read all output
  const procPromise = (async () => {
    // Read all stdout and stderr using Bun's text() method
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { stdout, stderr, exitCode };
  })();

  try {
    return await Promise.race([procPromise, timeoutPromise]);
  } catch (error) {
    // Kill the process if it's still running
    proc.kill();
    throw error;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

export interface VideoInfoOptions {
  /**
   * Reject the video when yt-dlp reports a `filesize` above the limit. Only
   * meaningful for callers that go on to download that media stream: the
   * reported size describes the default format, so metadata, transcript, and
   * MP4 callers would otherwise be refused work they never attempt.
   */
  enforceFileSizeLimit?: boolean;
  /**
   * Accept any http(s) URL or an existing local file path, not just YouTube.
   * Used by the transcript surfaces that also transcribe regular videos.
   */
  allowAnySource?: boolean;
}

export type SourceKind = "youtube" | "url" | "local";

function looksLikeHttpUrl(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function normalizeHttpUrl(input: string): string {
  return /^https?:\/\//i.test(input) ? input : `https://${input}`;
}

async function isExistingFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/**
 * Rejects http(s) URLs whose literal host is a loopback, private, link-local,
 * or otherwise non-public IP. Hostname-based SSRF (e.g. a DNS name resolving
 * to an internal address) remains a documented limitation of the any-source
 * transcript path.
 */
function isDeniedTargetHost(urlString: string): boolean {
  let host: string;
  try {
    host = new URL(urlString).hostname;
  } catch {
    return true;
  }
  if (!host) return true;

  // URL.hostname keeps the brackets around IPv6 literals; isIP() needs them off.
  const ipHost = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

  if (isIP(ipHost) === 4) {
    const [a = 0, b = 0] = ipHost.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  if (isIP(ipHost) === 6) {
    const lower = ipHost.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10
    return false;
  }

  return false;
}

/**
 * Classifies an input as a YouTube URL, another http(s) URL, or a local file
 * path. Anything that is none of those is rejected as an invalid source.
 */
export async function resolveSourceKind(input: string): Promise<SourceKind> {
  const candidate = input.trim();
  if (!candidate) {
    throw new InvalidUrlError(candidate, `Invalid source: ${candidate}`);
  }

  if (looksLikeHttpUrl(candidate)) {
    if (hasCommandInjection(candidate)) {
      throw new InvalidUrlError(candidate, `Invalid source: ${candidate}`);
    }
    if (!isValidYouTubeUrl(candidate) && isDeniedTargetHost(candidate)) {
      throw new InvalidUrlError(candidate, `Invalid source: ${candidate}`);
    }
    return isValidYouTubeUrl(candidate) ? "youtube" : "url";
  }

  if (isValidYouTubeUrl(candidate)) {
    // isValidYouTubeUrl already rejects command injection.
    return "youtube";
  }

  // Local files are passed to FFmpeg as a single array argument, so shell
  // metacharacters in a real file path are not an injection vector here.
  if (await isExistingFile(candidate)) {
    return "local";
  }

  throw new InvalidUrlError(candidate, `Invalid source: ${candidate}`);
}

/**
 * Extracts video information without downloading
 */
export async function getVideoInfo(url: string, options: VideoInfoOptions = {}): Promise<VideoInfo> {
  const { enforceFileSizeLimit = false, allowAnySource = false } = options;
  const kind = await resolveSourceKind(url);

  if (kind === "local") {
    if (!allowAnySource) {
      throw new InvalidUrlError(url);
    }
    // Local files have no extractor metadata; derive a stable identity from
    // the filename so the shared transcript surfaces can name the output.
    const path = resolve(url);
    const stem = sanitizeFilename(basename(path, extname(path)));
    return {
      id: stem,
      title: stem,
      duration: 0,
      thumbnail: "",
      uploader: "",
      upload_date: "",
    };
  }

  if (kind !== "youtube" && !allowAnySource) {
    throw new InvalidUrlError(url);
  }

  // Sanitize URL - prevent command injection by passing as separate argument
  // (Bun.spawn with array arguments handles this safely)
  const cleanUrl = normalizeHttpUrl(url.trim());

  try {
    const result = await spawnYtDlp(["--dump-json", "--no-playlist", cleanUrl], METADATA_TIMEOUT_SECONDS);

    if (!result.stdout) {
      throw parseYtDlpError(result.stderr);
    }

    const info = JSON.parse(result.stdout);

    // Check file size if available
    if (enforceFileSizeLimit && info.filesize && info.filesize > MAX_FILE_SIZE) {
      throw new FileSizeError(MAX_FILE_SIZE / (1024 * 1024), info.filesize / (1024 * 1024));
    }

    // Non-YouTube extractors may not report every field; normalize to empty
    // strings so the shared VideoInfo shape stays complete.
    return {
      id: info.id ?? "",
      title: info.title ?? "",
      duration: typeof info.duration === "number" ? info.duration : 0,
      thumbnail: info.thumbnail ?? "",
      uploader: info.uploader ?? "",
      upload_date: info.upload_date ?? "",
    };
  } catch (error) {
    if (error instanceof InvalidUrlError || error instanceof VideoNotAccessibleError ||
        error instanceof NetworkTimeoutError || error instanceof FileSizeError) {
      throw error;
    }

    // Try to parse yt-dlp error from stderr
    if (error instanceof ConverterError) {
      throw error;
    }

    if (error instanceof SyntaxError || (error instanceof Error && /json.*parse/i.test(error.message))) {
      throw new ConverterError("Failed to parse video information", "PARSE_ERROR", 500);
    }

    throw new ConverterError(
      `Failed to get video info: ${error instanceof Error ? error.message : String(error)}`,
      "VIDEO_INFO_FAILED",
      500
    );
  }
}

/**
 * Downloads and converts video to MP3 format
 */
export async function convertToMp3(url: string, outputPath: string): Promise<string> {
  if (!isValidYouTubeUrl(url)) {
    throw new InvalidUrlError(url);
  }

  const cleanUrl = url.trim();
  const safePath = sanitizeOutputPath(outputPath);

  const args = [
    "-x",                          // Extract audio
    "--audio-format", "mp3",       // Convert to MP3
    "--audio-quality", "0",        // Best quality
    "--no-playlist",               // Download single video only
    "-o", safePath,                // Output file
    "--no-progress",               // Cleaner output
    "--newline",                   // Use newlines for progress
    "--max-filesize", `${MAX_FILE_SIZE}`, // Max file size
    cleanUrl,
  ];

  try {
    const result = await spawnYtDlp(args, FORMAT_TIMEOUT_SECONDS.mp3);

    if (result.exitCode !== 0) {
      throw parseYtDlpError(result.stderr);
    }

    // Verify file was created
    const finalPath = `${safePath}.mp3`;
    const file = Bun.file(finalPath);
    if (!(await file.exists())) {
      throw new ConversionError("mp3", "Output file was not created");
    }

    return finalPath;
  } catch (error) {
    if (error instanceof InvalidUrlError || error instanceof VideoNotAccessibleError ||
        error instanceof NetworkTimeoutError || error instanceof FileSizeError ||
        error instanceof ConversionError) {
      throw error;
    }
    throw new ConversionError("mp3", error instanceof Error ? error.message : String(error));
  }
}

/**
 * Downloads video in MP4 format
 */
export async function convertToMp4(url: string, outputPath: string): Promise<string> {
  if (!isValidYouTubeUrl(url)) {
    throw new InvalidUrlError(url);
  }

  const cleanUrl = url.trim();
  const safePath = sanitizeOutputPath(outputPath);

  const args = [
    "-f", "bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best", // Best quality MP4
    "--merge-output-format", "mp4",    // Ensure output is MP4
    "--no-playlist",                   // Download single video only
    "-o", safePath,                    // Output file
    "--no-progress",                   // Cleaner output
    "--newline",                       // Use newlines for progress
    // Note: No --max-filesize for video - videos are legitimately large (1080p ~100MB/min)
    cleanUrl,
  ];

  try {
    // Use longer timeout for video due to larger file sizes
    const result = await spawnYtDlp(args, FORMAT_TIMEOUT_SECONDS.mp4);

    if (result.exitCode !== 0) {
      throw parseYtDlpError(result.stderr);
    }

    // Verify file was created
    const finalPath = `${safePath}.mp4`;
    const file = Bun.file(finalPath);
    if (!(await file.exists())) {
      throw new ConversionError("mp4", "Output file was not created");
    }

    return finalPath;
  } catch (error) {
    if (error instanceof InvalidUrlError || error instanceof VideoNotAccessibleError ||
        error instanceof NetworkTimeoutError || error instanceof FileSizeError ||
        error instanceof ConversionError) {
      throw error;
    }
    throw new ConversionError("mp4", error instanceof Error ? error.message : String(error));
  }
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function captionsToPlainText(captions: string): string {
  const lines = captions
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim());

  const transcript: string[] = [];
  let skippingBlock = false;

  for (const [index, line] of lines.entries()) {
    if (!line) {
      skippingBlock = false;
      continue;
    }

    if (/^(WEBVTT|Kind:|Language:)/i.test(line)) continue;
    if (/^(NOTE|STYLE|REGION)(\s|$)/i.test(line)) {
      skippingBlock = true;
      continue;
    }
    if (skippingBlock) continue;
    // An SRT cue index is only an index when a timing line follows it;
    // otherwise it is spoken text such as a year or a countdown.
    if (/^\d+$/.test(line) && lines[index + 1]?.includes("-->")) continue;
    if (line.includes("-->")) continue;

    const plain = decodeHtmlEntities(
      line
        .replace(/<[^>]+>/g, "")
        .replace(/\{\\[^}]+\}/g, "")
        .replace(/\s+/g, " ")
        .trim()
    );

    if (plain && transcript[transcript.length - 1] !== plain) {
      transcript.push(plain);
    }
  }

  return transcript.join("\n") + "\n";
}

async function listCaptionFiles(outputPath: string): Promise<string[]> {
  const directory = dirname(outputPath);
  const prefix = `${basename(outputPath)}.`;

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    // yt-dlp creates the output directory itself, so a missing directory just
    // means this invocation produced nothing.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  return entries.filter((file) => file.startsWith(prefix) && /\.(vtt|srt)$/i.test(file));
}

async function findCaptionFile(outputPath: string): Promise<string | undefined> {
  const directory = dirname(outputPath);

  return (await listCaptionFiles(outputPath))
    .sort((a, b) => {
      const aIsEnglish = /\.en(-|\.|$)/i.test(a);
      const bIsEnglish = /\.en(-|\.|$)/i.test(b);
      return Number(bIsEnglish) - Number(aIsEnglish);
    })
    .map((file) => `${directory}/${file}`)[0];
}

export interface TranscriptOptions {
  /**
   * When true, a URL without usable English captions falls back to local
   * speech-to-text. Local file inputs always use speech-to-text. Caption-only
   * surfaces (such as the YouTube MCP tool) pass false to preserve their
   * contract.
   */
  sttFallback?: boolean;
  /** Called once before a captions-missing URL begins speech-to-text. */
  onSttFallback?: () => void;
}

/**
 * Finds the media file yt-dlp produced for a caller-supplied base path whose
 * template ended in `%(ext)s`.
 */
async function findDownloadedMedia(outputPath: string): Promise<string | undefined> {
  const directory = dirname(outputPath);
  const prefix = `${basename(outputPath)}.`;

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    // yt-dlp creates the output directory itself, so a missing directory just
    // means this invocation produced nothing.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }

  const file = entries.find(
    (name) => name.startsWith(prefix) && !name.endsWith(".part") && !name.endsWith(".ytdl"),
  );
  return file ? `${directory}/${file}` : undefined;
}

/**
 * Downloads just the audio stream for a URL into a unique, caller-provided
 * output base path and returns the absolute path yt-dlp created. Used as the
 * first step of the speech-to-text fallback.
 */
export async function downloadAudioForStt(url: string, outputPath: string): Promise<string> {
  const safePath = sanitizeOutputPath(outputPath);
  const args = [
    "-f", "bestaudio/best",
    "--no-playlist",
    // Keep the audio download bounded like the MP3 path so a handful of
    // transcript jobs cannot exhaust disk.
    "--max-filesize", `${MAX_FILE_SIZE}`,
    "-o", `${safePath}.%(ext)s`,
    "--no-progress",
    "--newline",
    normalizeHttpUrl(url.trim()),
  ];

  const result = await spawnYtDlp(args, AUDIO_DOWNLOAD_TIMEOUT_SECONDS);
  if (result.exitCode !== 0) {
    throw parseYtDlpError(result.stderr);
  }

  const audioPath = await findDownloadedMedia(safePath);
  if (!audioPath) {
    throw new ConversionError("transcript", "Audio download produced no file");
  }
  return audioPath;
}

/**
 * Downloads available captions, or falls back to local speech-to-text, and
 * saves the result as a plain-text transcript. Accepts YouTube and other
 * http(s) URLs, as well as local media files.
 */
export async function downloadTranscript(
  input: string,
  outputPath: string,
  options: TranscriptOptions = {},
): Promise<string> {
  const { sttFallback = true, onSttFallback } = options;
  const kind = await resolveSourceKind(input);

  if (kind === "local") {
    if (!sttFallback) {
      throw new ConversionError("transcript", "Local video files have no captions; speech-to-text is disabled");
    }
    return transcribeAudioFile(input, `${outputPath}.txt`);
  }

  const safePath = sanitizeOutputPath(outputPath);
  const cleanUrl = normalizeHttpUrl(input.trim());
  let workingDirectory: string | undefined;

  try {
    const outputDirectory = dirname(safePath);
    await mkdir(outputDirectory, { recursive: true });
    workingDirectory = await mkdtemp(`${outputDirectory}/.${basename(safePath)}-transcript-`);
    const invocationPath = `${workingDirectory}/${basename(safePath)}`;
    const args = [
      "--skip-download",
      "--write-subs",
      "--write-auto-subs",
      "--sub-langs", "en.*",
      "--sub-format", "vtt/srt",
      "--no-playlist",
      "-o", invocationPath,
      "--no-progress",
      cleanUrl,
    ];
    const result = await spawnYtDlp(args, CAPTIONS_TIMEOUT_SECONDS);

    if (result.exitCode !== 0) {
      throw parseYtDlpError(result.stderr);
    }

    const captionPath = await findCaptionFile(invocationPath);
    if (captionPath) {
      const rawCaptions = await Bun.file(captionPath).text();
      const transcript = captionsToPlainText(rawCaptions);
      if (transcript.trim()) {
        const finalPath = `${safePath}.txt`;
        await Bun.write(finalPath, transcript);
        return finalPath;
      }
      if (!sttFallback) {
        throw new ConversionError("transcript", "Downloaded captions did not contain readable transcript text");
      }
    }

    if (!sttFallback) {
      throw new ConversionError("transcript", "No English captions or transcript were found for this video");
    }

    onSttFallback?.();
    const audioPath = await downloadAudioForStt(cleanUrl, resolve(workingDirectory, "audio"));
    return await transcribeAudioFile(audioPath, `${safePath}.txt`);
  } catch (error) {
    if (error instanceof InvalidUrlError || error instanceof VideoNotAccessibleError ||
        error instanceof NetworkTimeoutError || error instanceof FileSizeError ||
        error instanceof RateLimitError || error instanceof ConversionError ||
        error instanceof TranscriptionError || error instanceof WhisperUnavailableError) {
      throw error;
    }
    throw new ConversionError("transcript", error instanceof Error ? error.message : String(error));
  } finally {
    if (workingDirectory) {
      await rm(workingDirectory, { recursive: true, force: true });
    }
  }
}

/**
 * Generates a unique job ID
 */
export function generateJobId(): string {
  return `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Sanitizes a string input to prevent XSS and injection attacks
 * Removes or escapes potentially dangerous characters
 */
export function sanitizeString(input: string, maxLength: number = 1000): string {
  if (!input) return "";

  // Remove null bytes and dangerous control characters
  // We keep newlines (\n = 0x0A) and tabs (\t = 0x09) for multi-line text inputs
  // Remove everything in range 0x00-0x08, 0x0B-0x0D, 0x0E-0x1F, and 0x7F (DEL)
  let sanitized = input.replace(/[\x00-\x08\x0B-\x1F\x7F]/g, "");

  // Limit length to prevent DoS attacks via extremely long inputs
  if (sanitized.length > maxLength) {
    sanitized = sanitized.slice(0, maxLength);
  }

  return sanitized;
}

/**
 * Sanitizes a filename by removing invalid characters
 * Enhanced to prevent path traversal and other file-based attacks
 */
export function sanitizeFilename(filename: string): string {
  if (!filename) return "unnamed";

  // Check for severe threats like command injection with shell metacharacters
  // We exclude common filename characters like : [ ] . ( ) - _
  // The goal is to detect actual shell command injection, not valid filename chars
  const severeThreats = /[;|`$\\]/

  if (severeThreats.test(filename)) {
    // If malicious patterns detected, return a safe default
    return "sanitized_filename";
  }

  return filename
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, "") // Remove invalid characters and control chars
    .replace(/\.\./g, "")                  // Remove directory traversal patterns
    .replace(/^\.+/, "")                   // Remove leading dots (hidden files)
    .replace(/^\/+/, "")                   // Remove leading slashes
    .replace(/\s+/g, "_")                  // Replace spaces with underscores
    .slice(0, 200);                        // Limit length to prevent filesystem issues
}

/**
 * Sanitizes an output path by preserving the directory and sanitizing only the filename
 * Note: The directory is assumed to be server-controlled (from DOWNLOAD_DIR env var)
 * and the filename portion will be sanitized by sanitizeFilename
 */
export function sanitizeOutputPath(outputPath: string): string {
  if (!outputPath) return "unnamed";

  // Split into directory and filename
  const lastSlash = outputPath.lastIndexOf("/");
  if (lastSlash === -1) {
    // No directory, just sanitize the filename
    return sanitizeFilename(outputPath);
  }

  const directory = outputPath.slice(0, lastSlash + 1);
  const filename = outputPath.slice(lastSlash + 1);

  // Validate directory doesn't contain traversal attempts
  if (directory.includes("..")) {
    throw new InvalidUrlError("Invalid output path: directory traversal not allowed");
  }

  return directory + sanitizeFilename(filename);
}

/**
 * Validates and sanitizes a YouTube URL with comprehensive security checks
 *
 * This function performs multiple layers of validation:
 * 1. Command injection detection
 * 2. URL format validation using regex
 * 3. Length validation to prevent DoS
 * 4. Character whitelist validation for the video ID portion
 */
export function sanitizeAndValidateYouTubeUrl(url: string): { isValid: boolean; sanitized?: string; error?: string } {
  // Check if input exists
  if (!url || typeof url !== "string") {
    return { isValid: false, error: "URL is required and must be a string" };
  }

  const trimmed = url.trim();

  // Check length (YouTube URLs are typically < 200 chars)
  if (trimmed.length > 500) {
    return { isValid: false, error: "URL is too long" };
  }

  // Check for command injection
  if (hasCommandInjection(trimmed)) {
    return { isValid: false, error: "URL contains potentially malicious content" };
  }

  // Validate against YouTube regex
  if (!YOUTUBE_REGEX.test(trimmed)) {
    return { isValid: false, error: "Invalid YouTube URL format" };
  }

  // Extract and validate the video ID (should be 11 characters, alphanumeric with - and _)
  const videoIdMatch = trimmed.match(/(?:[?&]v=|\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
  if (!videoIdMatch) {
    return { isValid: false, error: "Could not extract valid video ID" };
  }

  const videoId = videoIdMatch[1];
  if (!videoId) {
    return { isValid: false, error: "Could not extract valid video ID" };
  }

  // Additional validation: video ID should only contain safe characters
  if (!/^[a-zA-Z0-9_-]+$/.test(videoId)) {
    return { isValid: false, error: "Video ID contains invalid characters" };
  }

  return { isValid: true, sanitized: trimmed };
}
