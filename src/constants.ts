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

// ============================================================================
// Compaction
// ============================================================================

/**
 * Auto-compact a thread when its context occupancy reaches this percent of the
 * model's window. Env-overridable via `config.compactionThresholdPercent`
 * (COMPACTION_THRESHOLD_PERCENT); 0 disables auto-compaction.
 */
export const COMPACTION_THRESHOLD_PERCENT = 90;

/**
 * Newest messages kept out of compaction — they stay in the context verbatim
 * so the conversation keeps its immediate continuity. Env-overridable via
 * `config.compactionTailMessages` (COMPACTION_TAIL_MESSAGES).
 */
export const COMPACTION_TAIL_MESSAGES = 6;

/**
 * Context window assumed by the auto-compaction trigger when the model's real
 * window is unknown (no catalog entry, no CONTEXT_WINDOW_TOKENS override).
 * Deliberately generous — no current Claude window is larger, so this only
 * fires when the thread is genuinely enormous, and a wrong small guess would
 * compact constantly. Trigger-only by design: the context meter never renders
 * a percentage derived from this guess.
 */
export const COMPACTION_FALLBACK_WINDOW_TOKENS = 1_000_000;
