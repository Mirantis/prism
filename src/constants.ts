export const STEP_LIMIT = 100;
export const MAX_OUTPUT_TOKENS = 16000;

/**
 * Max size of a single shared file (web upload or Slack attachment). Mirrors
 * the shell output cap (`MAX_EXEC_OUTPUT_BYTES`). Enforced by the multer limit
 * on the upload route and re-checked server-side; oversized Slack files are
 * skipped before download.
 */
export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Display form of MAX_FILE_SIZE_BYTES for user-facing messages. */
export const MAX_FILE_SIZE_MB = MAX_FILE_SIZE_BYTES / (1024 * 1024);

/**
 * Max characters of a text/code attachment inlined into the LLM context.
 * Bounds token cost when a large text file is re-exposed every turn; the file
 * is still stored in full and downloadable. ~25k tokens at 4 chars/token.
 */
export const MAX_INLINE_TEXT_CHARS = 100_000;
