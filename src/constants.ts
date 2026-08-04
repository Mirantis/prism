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

/**
 * Max characters of text attachments inlined across a whole context build.
 *
 * MAX_INLINE_TEXT_CHARS bounds one attachment; this bounds their sum. Without
 * it the caps multiply — 100 attachments of 100k chars is 10M characters in a
 * single request, re-sent on every one of the STEP_LIMIT steps a turn may take,
 * since history is rebuilt from scratch each step.
 *
 * That is not theoretical. A conversation carrying eight ~99k-char attachments
 * put enough text through the Nexus PII masker to exceed its request budget,
 * and every step of every turn paid it again.
 *
 * The budget is spent newest-first (see selectInlinableTextAttachments): the
 * file the user just shared is the one they are asking about, so it must never
 * be the one dropped to make room for an older one.
 */
export const MAX_INLINE_TEXT_CHARS_TOTAL = 300_000;

/**
 * Max attachments linked to a single message. Bounds aggregate memory at
 * context-build time — every windowed attachment's bytes are loaded and
 * base64-expanded for the model on each turn, before the budget gate runs —
 * so an unbounded count could OOM the container. Enforced server-side in
 * `attachmentService.linkToMessage` (the chokepoint for web + Slack) and
 * mirrored as a UX guard in the web composer and CLI.
 */
export const MAX_ATTACHMENTS_PER_MESSAGE = 100;

// ============================================================================
// Goals
// ============================================================================

/**
 * Default hard cap on autonomous goal turns before the loop stops with status
 * `turn_limited`. Env-overridable via `config.goalMaxTurns` (GOAL_MAX_TURNS).
 */
export const GOAL_MAX_TURNS = 100;

/** Max characters allowed in a goal objective (matches Claude Code / Codex). */
export const GOAL_MAX_OBJECTIVE_CHARS = 4000;

/**
 * Consecutive zero-progress goal turns (a turn with no tool calls while the
 * completion gate still says CONTINUE) before the goal is marked `blocked`.
 * Stops a goal that can no longer make headway from spinning to the turn cap.
 */
export const GOAL_MAX_STALL_TURNS = 2;

/** Pause between goal turns so the background loop never hot-spins. */
export const GOAL_TURN_DELAY_MS = 200;
