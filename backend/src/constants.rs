//! Shared constants.

use std::sync::LazyLock;

use regex::Regex;

pub const STEP_LIMIT: i64 = 100;
pub const MAX_OUTPUT_TOKENS: i64 = 16000;

/// Heartbeat interval of a new agent when `HEARTBEAT_INTERVAL_MS` is unset or invalid: 8 h.
pub const DEFAULT_HEARTBEAT_INTERVAL_MS: i64 = 28_800_000;

/// The shortest heartbeat interval an agent may have: 1 minute.
pub const MIN_HEARTBEAT_INTERVAL_MS: i64 = 60_000;

/// The longest heartbeat interval an agent may have: 1 week.
pub const MAX_HEARTBEAT_INTERVAL_MS: i64 = 7 * 24 * 60 * 60_000;

/// Max size of a single shared file (web upload or a file a channel received).
/// Mirrors the shell output cap (`MAX_EXEC_OUTPUT_BYTES`). Enforced by the
/// upload limit on the upload route and re-checked server-side; a channel skips
/// an oversized file before download.
pub const MAX_FILE_SIZE_BYTES: i64 = 10 * 1024 * 1024; // 10 MB

/// Display form of MAX_FILE_SIZE_BYTES for user-facing messages.
pub const MAX_FILE_SIZE_MB: i64 = MAX_FILE_SIZE_BYTES / (1024 * 1024);

/// Max attachments linked to a single message. Bounds the per-message stub
/// count in the LLM context and the media-dir write volume one message can
/// cause. Enforced server-side in `attachmentService.linkToMessage` (the
/// chokepoint for every upload path) and mirrored as a UX guard in the web
/// composer and CLI.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 100;

/// The most messages one page of a thread's history holds.
pub const MAX_MESSAGE_PAGE: i64 = 200;

/// Default retention of attachment content: 168 h (7 days). After that the
/// hourly sweep deletes the media file; the metadata row (and its stub in the
/// conversation) survives, so history stays intact while the bytes are gone.
/// Env-overridable via `config.attachment_content_ttl_ms` (ATTACHMENT_TTL_HOURS).
pub const ATTACHMENT_CONTENT_TTL_HOURS: i64 = 168;

/// How long a saved tool output is kept before the janitor deletes it.
///
/// Paired with `ATTACHMENT_CONTENT_TTL_HOURS` on purpose: both are durable copies
/// of content the conversation refers to but does not hold, so one sentence in the
/// docs covers the retention of both.
pub const TOOL_OUTPUT_TTL_HOURS: i64 = 168;

// ============================================================================
// Goals
// ============================================================================

/// Default hard cap on autonomous goal turns before the loop stops with status
/// `turn_limited`. Env-overridable via `config.goal_max_turns` (GOAL_MAX_TURNS).
pub const GOAL_MAX_TURNS: i64 = 100;

/// Max characters allowed in a goal objective (matches Claude Code / Codex).
pub const GOAL_MAX_OBJECTIVE_CHARS: usize = 4000;

/// Consecutive zero-progress goal turns (a turn with no tool calls while the
/// completion gate still says CONTINUE) before the goal is marked `blocked`.
/// Stops a goal that can no longer make headway from spinning to the turn cap.
pub const GOAL_MAX_STALL_TURNS: i64 = 2;

/// Pause between goal turns so the background loop never hot-spins.
pub const GOAL_TURN_DELAY_MS: i64 = 200;

// ============================================================================
// Compaction
// ============================================================================

/// Auto-compact a thread when its context occupancy reaches this percent of the
/// model's window. Env-overridable via `config.compaction_threshold_percent`
/// (COMPACTION_THRESHOLD_PERCENT); 0 disables auto-compaction.
pub const COMPACTION_THRESHOLD_PERCENT: i64 = 90;

/// Send the platform and plugin MCP tools deferred, behind `load_tools`, when
/// their definitions take more than this percent of the model's window.
/// Env-overridable via `config.tool_search_threshold_percent`
/// (TOOL_SEARCH_THRESHOLD_PERCENT).
pub const TOOL_SEARCH_THRESHOLD_PERCENT: f64 = 2.0;

/// At most this many of the newest messages stay out of compaction, verbatim in the context,
/// so the conversation keeps its immediate continuity. Env-overridable via
/// `config.compaction_tail_messages` (COMPACTION_TAIL_MESSAGES).
pub const COMPACTION_TAIL_MESSAGES: i64 = 6;

/// The most tokens those kept messages may hold, tool calls and results included.
/// Bounds the kept tail, so the context falls below the trigger after a compaction.
pub const COMPACTION_TAIL_TOKENS: i64 = 30_000;

/// A chat conversation at least this large is compacted when it sits idle until
/// shortly before its cache expires, so the next turn writes a summary to the cache
/// instead of the whole thread. Below it, the saving does not pay for the summary.
pub const IDLE_COMPACTION_MIN_TOKENS: i64 = 200_000;

/// The share of the chat cache's lifetime a conversation sits idle before it is
/// compacted: just inside the cache, which the summary then reads.
pub const IDLE_COMPACTION_CACHE_SHARE: f64 = 0.9;

// ============================================================================
// Updates
// ============================================================================

/// Release version shape: vYYYY.M.DDHHMMSS, generated by release-production.yml.
/// The updater only runs where the baked version matches this shape: dev,
/// canary and pull-request builds never update themselves.
pub static RELEASE_VERSION_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^v[0-9]{4}\.[0-9]{1,2}\.[0-9]+$").expect("valid regex"));

/// GHCR container package whose tag list the version check reads.
pub const UPDATE_IMAGE_REPO: &str = "mirantis/prism";

/// GitHub repository whose Releases hold the packaged archives.
pub const UPDATE_GITHUB_REPO: &str = "Mirantis/prism";

/// Delay before the first update check so it never competes with startup.
pub const UPDATE_FIRST_CHECK_DELAY_MS: i64 = 60 * 1000;

/// Interval between update checks.
pub const UPDATE_CHECK_INTERVAL_MS: i64 = 60 * 60 * 1000;

/// Windows only: how long the staged installer gets to stop this process
/// before the update is recorded as failed. Generous, since it has to stop a
/// scheduled task, swap the install and start the task again, but bounded,
/// since nothing else would ever notice that the handoff died.
pub const WINDOWS_HANDOFF_TIMEOUT_MS: i64 = 5 * 60 * 1000;

/// Context window assumed by the auto-compaction trigger when the model's real
/// window is unknown (no catalog entry, no CONTEXT_WINDOW_TOKENS override).
/// Deliberately generous: no current Claude window is larger, so this only
/// fires when the thread is genuinely enormous, and a wrong small guess would
/// compact constantly. Trigger-only by design: the context meter never renders
/// a percentage derived from this guess.
pub const COMPACTION_FALLBACK_WINDOW_TOKENS: i64 = 1_000_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_only_release_shaped_versions() {
        assert!(RELEASE_VERSION_RE.is_match("v2026.6.18060952"));
        assert!(!RELEASE_VERSION_RE.is_match("canary-abc123"));
        assert!(!RELEASE_VERSION_RE.is_match("v2026.6"));
    }
}
