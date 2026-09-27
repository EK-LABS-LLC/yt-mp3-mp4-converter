import { z } from "zod";

const YOUTUBE_REGEX = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|shorts\/|embed\/)|youtu\.be\/)[\w-]+/;
const YOUTUBE_ID_PATTERN = /(?:[?&]v=|\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/;

function isHttpSource(input: string): boolean {
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Zod schema for validating convert request payloads
 *
 * This schema provides comprehensive validation for the /api/convert endpoint:
 * - URL validation with custom refinements
 * - Format validation (only mp3 or mp4 allowed)
 * - Length limits to prevent DoS
 * - Type safety
 *
 * MP3 and MP4 remain YouTube-only. Transcript accepts any http(s) URL because
 * the transcript surface can transcribe regular videos with speech-to-text.
 */
export const convertRequestSchema = z.object({
  url: z.string("URL is required and must be a string")
    .min(1, "URL cannot be empty")
    .max(500, "URL is too long (maximum 500 characters)")
    .trim()
    .refine(
      (val) => {
        // Check for command injection patterns
        const dangerousPatterns = [
          /[;&|`$()]/,           // Shell metacharacters
          /\n/,                   // Newline
          /\r/,                   // Carriage return
          /\t/,                   // Tab
          /\x00/,                 // Null byte
          /\.\./,                 // Directory traversal
        ];
        return !dangerousPatterns.some(pattern => pattern.test(val));
      },
      "URL contains invalid or potentially malicious characters"
    )
    .transform((val) => {
      // Sanitize the URL by trimming and ensuring valid protocol
      const trimmed = val.trim();
      // Add https:// if no protocol specified
      if (!trimmed.match(/^https?:\/\//i)) {
        return `https://${trimmed}`;
      }
      return trimmed;
    }),

  format: z.enum(["mp3", "mp4", "transcript", "instrumental"], "Format must be 'mp3', 'mp4', 'transcript', or 'instrumental'"),

  // Optional: quality preference (for future use)
  quality: z.enum(["low", "medium", "high"], "Quality must be 'low', 'medium', or 'high'").optional(),
}).superRefine((data, ctx) => {
  if (data.format === "mp3" || data.format === "mp4" || data.format === "instrumental") {
    // Validate YouTube URL format and video ID
    if (!YOUTUBE_REGEX.test(data.url) || !YOUTUBE_ID_PATTERN.test(data.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["url"],
        message: "Invalid YouTube URL format",
      });
    }
  } else if (!isHttpSource(data.url)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["url"],
      message: "Invalid source URL",
    });
  }
});

/**
 * Type inference from the convert request schema
 */
export type ConvertRequest = z.infer<typeof convertRequestSchema>;

/**
 * Schema for validating job ID parameters
 */
export const jobIdSchema = z.string("Job ID is required and must be a string")
  .min(1, "Job ID cannot be empty")
  .max(100, "Job ID is too long")
  .refine(
    (val) => /^[a-zA-Z0-9-]+$/.test(val),
    "Job ID contains invalid characters"
  );

/**
 * Schema for validating URL query parameters
 */
export const urlQuerySchema = z.object({
  url: z.string().min(1).max(500).optional(),
  format: z.enum(["mp3", "mp4", "transcript", "instrumental"]).optional(),
});

/**
 * Sanitization utilities for user input
 */
export const Sanitizer = {
  /**
   * Sanitizes a string by removing control characters and limiting length
   */
  string(input: string, maxLength: number = 1000): string {
    if (!input) return "";

    return input
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "") // Remove control chars
      .slice(0, maxLength);
  },

  /**
   * Sanitizes a filename for safe filesystem use
   */
  filename(input: string): string {
    if (!input) return "unnamed";

    return input
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "")
      .replace(/\.\./g, "")
      .replace(/^\.+/, "")
      .replace(/^\/+/, "")
      .replace(/\s+/g, "_")
      .slice(0, 200);
  },

  /**
   * Sanitizes a URL by removing dangerous characters while preserving valid URL structure
   */
  url(input: string): string {
    if (!input) return "";

    return input
      .trim()
      .replace(/[\x00-\x1F\x7F]/g, "") // Remove control chars
      .slice(0, 500);
  },
};

/**
 * Error response types for validation failures
 */
export const ValidationError = {
  INVALID_URL: "INVALID_URL",
  MALICIOUS_INPUT: "MALICIOUS_INPUT",
  INVALID_FORMAT: "INVALID_FORMAT",
  MISSING_REQUIRED_FIELD: "MISSING_REQUIRED_FIELD",
  INVALID_JOB_ID: "INVALID_JOB_ID",
} as const;
