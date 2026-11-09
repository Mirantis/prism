//! Tool Output Limiter
//!
//! The single owner of "render a tool result for a model, and cut it if it is too
//! big". Both paths that hand a tool result to a model use it:
//!
//! - the invoke loop (chat, heartbeat, cron, goals, subagents) via
//!   [`with_tool_output_capture`], which wraps each tool's `execute`;
//! - a live voice meeting via [`render_and_spill`] in the Realtime tool bridge,
//!   which has no AI SDK loop to hook into.
//!
//! They differ only in budget — a meeting's is deliberately smaller, see the
//! bridge — never in shape, because a truncation that behaves differently per
//! channel is a bug report waiting to happen: a payload that reads whole in a chat
//! and arrives beheaded in a call looks like the *data* is missing.
//!
//! Strategy:
//! - Keep the first 80% of the budget (structural headers, column names, initial
//!   results) and the last 20% (end-of-output, summary lines, final entries).
//! - Replace the middle with a notice that says the output is INCOMPLETE. That
//!   wording is the point: a model handed a silently-clipped list reports the
//!   entries it can see as the whole set, so the notice forbids stating a count or
//!   a total and names the way to get the rest (narrower arguments, fewer fields,
//!   the next page).

use crate::ai::{
    ToModelOutputFunction, ToModelOutputOptions, Tool, ToolExecuteFunction, ToolResultOutput,
    ToolSet,
};
use crate::lib::tool_output_store::{SpillResult, write_tool_output};
use crate::support::js::{len16, slice16, stringify};
use crate::types::ToolOutputTruncation;
use crate::{log_debug, log_warn};
use regex::Regex;
use serde::Serialize;
use serde::ser::SerializeStruct;
use serde_json::{Value, json};
use std::sync::Arc;
use std::sync::LazyLock;

const DEFAULT_MAX_CHARS: usize = 30_000;
const HEAD_RATIO: f64 = 0.8;

/// Slack above the budget before truncating is worth it: cutting a result to add a
/// ~400-char notice about the 30 chars removed costs the model more than it saves.
const PASSTHROUGH_SLACK: usize = 500;

#[derive(Debug, Clone, Default)]
pub struct RenderToolResultOptions {
    /// Character budget for the model-facing text. Defaults to 30,000.
    pub max_chars: Option<usize>,
    /// Appended to the truncation notice — for channel-specific advice.
    pub extra_guidance: Option<String>,
    /// Names the tool in the truncation log line.
    pub tool_name: Option<String>,
    /// Log the cut at debug rather than warn.
    ///
    /// Set by the replay path: a legacy row is re-rendered on every context build, so
    /// one such row would otherwise warn on every turn — and during compaction — about
    /// a cut that happened once, drowning the live warns that mean something.
    pub quiet_log: Option<bool>,
}

/// Render a tool's return value as text for a model, truncated to `max_chars`.
///
/// Returns the text unchanged when it fits. When it doesn't, logs at warn with the
/// sizes involved — the only record that a model's view of a tool result was
/// narrowed, and the first thing to look at when an agent reports a count that
/// disagrees with reality.
pub fn render_tool_result(result: &Value, options: &RenderToolResultOptions) -> String {
    render_tool_result_detailed(result, options).text
}

/// A rendered tool result, plus what the render did to it.
#[derive(Debug, Clone, PartialEq)]
pub struct RenderedToolResult {
    /// The model-facing text. Head + notice + tail when it was cut.
    pub text: String,
    /// Present only when the result was cut.
    pub truncation: Option<ToolOutputTruncation>,
}

/// [`render_tool_result`], plus a structured record of the cut.
///
/// Callers that persist a result want to know *that* it was cut without parsing the
/// notice back out of the text — the notice is written for the model and its wording
/// is free to change. [`render_tool_result`] is this function's `.text`.
pub fn render_tool_result_detailed(
    result: &Value,
    options: &RenderToolResultOptions,
) -> RenderedToolResult {
    let max_chars = options.max_chars.unwrap_or(DEFAULT_MAX_CHARS);
    let text = stringify_tool_output(result);
    let length = len16(&text);
    if length <= max_chars + PASSTHROUGH_SLACK {
        return RenderedToolResult {
            text,
            truncation: None,
        };
    }

    // "content chars" because the returned string is the budget *plus* the notice —
    // anyone comparing this against the message size would otherwise see a mismatch.
    let tool_name = options.tool_name.as_deref().unwrap_or("tool");
    if options.quiet_log == Some(true) {
        log_debug!(
            "[ToolOutput] {} result truncated: kept {} content chars of {}",
            tool_name,
            max_chars,
            length
        );
    } else {
        log_warn!(
            "[ToolOutput] {} result truncated: kept {} content chars of {}",
            tool_name,
            max_chars,
            length
        );
    }
    let prior_omitted = sum_prior_omitted(&text);
    let cut = cut_head_tail(
        &text,
        max_chars,
        options.extra_guidance.as_deref(),
        prior_omitted,
        None,
    );
    RenderedToolResult {
        text: cut,
        truncation: Some(ToolOutputTruncation {
            total_chars: (prior_omitted + length as i64) as _,
            kept_chars: max_chars as _,
            omitted_chars: (prior_omitted + (length as i64 - max_chars as i64)) as _,
            spill_id: None,
        }),
    }
}

/// Render a tool result stored *before* results were persisted as the model-facing
/// view — a row with no `rendered` flag, holding `JSON.stringify(rawOutput)`.
///
/// The parse mirrors what `parse_tool_calls` already does for a tool call's `input`,
/// and it is what makes the replay match what the live turn showed: a stored MCP
/// envelope renders back down to its joined text, and a stored plain string loses
/// the quoting and escaping `JSON.stringify` added. An unparseable value is rendered
/// as-is.
///
/// Pure in (stored string, budget), so a legacy row's bytes are stable turn to turn —
/// they shift once, at the deploy that introduces this. `quiet_log` defaults to on.
pub fn render_legacy_stored_output(stored: &str, options: &RenderToolResultOptions) -> String {
    let parsed = match serde_json::from_str::<Value>(stored) {
        Ok(Value::Null) | Err(_) => Value::String(stored.to_string()),
        Ok(value) => value,
    };
    let options = RenderToolResultOptions {
        quiet_log: options.quiet_log.or(Some(true)),
        ..options.clone()
    };
    render_tool_result(&parsed, &options)
}

/// Matches a notice this module wrote earlier, capturing how much *that* pass dropped.
///
/// Cutting an already-cut result is real: a subagent's report is capped inside the
/// subagent's own turn and capped again by the parent, and a meeting's smaller budget
/// re-cuts a result a chat turn already cut. Without this the second notice would
/// report only its own slice, so a payload that lost 470,000 chars upstream would
/// claim to have lost 18,000.
static TRUNCATION_NOTICE_PATTERN: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"\[INCOMPLETE OUTPUT — ([0-9]+) chars omitted from the middle;")
        .expect("truncation notice pattern")
});

/// Ceiling on counts read back out of an earlier notice. Generous — a real chain of
/// cuts over a 10 MiB payload stays far below it — and its only job is to keep a
/// forged figure from producing a nonsense total.
const MAX_ACCUMULATED_OMITTED: f64 = 1_000_000_000.0;

fn sum_prior_omitted(text: &str) -> i64 {
    let mut total = 0.0_f64;
    for captures in TRUNCATION_NOTICE_PATTERN.captures_iter(text) {
        // The digits come from the text being cut, which a tool controls: `shell_exec`
        // reading a log that happens to contain an old notice, or a hostile payload.
        // An absurd figure must not reach the model or the row. A count can never
        // exceed what is actually in front of us plus what earlier passes dropped, so
        // anything past the ceiling is not ours.
        let omitted: f64 = captures[1].parse().unwrap_or(f64::INFINITY);
        if !omitted.is_finite() || omitted < 0.0 {
            continue;
        }
        total += omitted;
    }
    total.min(MAX_ACCUMULATED_OMITTED) as i64
}

/// Truncate text keeping the head and tail portions.
/// SRE tool outputs typically have column headers/structure at the top
/// and summary/status at the bottom.
pub fn truncate_head_tail(text: &str, max_chars: usize, extra_guidance: Option<&str>) -> String {
    cut_head_tail(text, max_chars, extra_guidance, 0, None)
}

/// [`truncate_head_tail`], told how much an earlier pass already dropped.
///
/// The notice has to report the accumulated figure, not this pass's slice: it is the
/// number the model reads, and a second cut that claims only its own 18,000 when
/// 488,000 are actually missing is the confident-wrong-total this notice exists to
/// prevent.
fn cut_head_tail(
    text: &str,
    max_chars: usize,
    extra_guidance: Option<&str>,
    prior_omitted: i64,
    spill: Option<&SpillResult>,
) -> String {
    let length = len16(text);
    let head_size = (max_chars as f64 * HEAD_RATIO).floor() as usize;
    let tail_size = max_chars - head_size;
    let omitted = prior_omitted + length as i64 - head_size as i64 - tail_size as i64;
    let total = prior_omitted + length as i64;
    let head = slice16(text, 0, head_size);
    // `slice(-0)` is the whole text.
    let tail = if tail_size == 0 {
        text.to_string()
    } else {
        slice16(text, length.saturating_sub(tail_size), length)
    };
    let extra = match extra_guidance {
        Some(extra) if !extra.is_empty() => format!(" {extra}"),
        _ => String::new(),
    };
    // Search-first, and said in those words. A pointer invites the model to page the
    // whole thing back in, which rebuilds in history exactly the bulk the cut removed
    // — and every page is itself a tool result, stored and replayed.
    let saved = match spill {
        Some(spill) => format!(
            "The full output is saved at {}. Read only what you need from it with shell_exec — `jq` when it is JSON, otherwise grep or sed. Do not cat the whole file: everything you read comes back into your context, which is what this cut just spared you.{} ",
            spill.path,
            if spill.capped {
                format!(" Only the first {} bytes were saved.", spill.bytes)
            } else {
                String::new()
            }
        ),
        None => String::new(),
    };
    format!(
        "{head}\n\n[INCOMPLETE OUTPUT — {omitted} chars omitted from the middle; {total} chars total. What follows this marker is the END of the output, so whatever was in the omitted middle — further entries, fields, statuses — is not visible to you. Do not state a count, a total, or that this is all of them. {saved}To see the rest, call again with narrower arguments: a filter, fewer fields, or the next page.{extra}]\n\n{tail}"
    )
}

/// Convert tool output to a string for the model.
/// Handles plain strings, MCP CallToolResult format, and JSON objects.
///
/// An absent output (JavaScript's `undefined`) renders as the empty string; a
/// caller holding one passes [`Value::Null`] only when the tool really returned
/// `null`.
pub fn stringify_tool_output(output: &Value) -> String {
    if let Value::String(text) = output {
        return text.clone();
    }
    if let Some(content) = mcp_call_tool_result_content(output) {
        return content
            .iter()
            .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|part| {
                part.get("text")
                    .filter(|text| crate::support::js::truthy(text))
            })
            .map(js_string)
            .collect::<Vec<_>>()
            .join("\n");
    }
    stringify(output)
}

/// `String(value)` for an element `Array.prototype.join` joins.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number
            .as_f64()
            .map(crate::support::js::number_text)
            .unwrap_or_default(),
        Value::Bool(flag) => flag.to_string(),
        Value::Null => String::new(),
        Value::Array(items) => items.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_string(),
    }
}

/// The `content` array of an MCP `CallToolResult`: an object whose `content` is an
/// array.
fn mcp_call_tool_result_content(output: &Value) -> Option<&Vec<Value>> {
    output.as_object()?.get("content")?.as_array()
}

// ============================================================================
// Saving the omitted middle
// ============================================================================

/// Marks a tool return that was cut. A tool's own return value is whatever the tool
/// says it is, so the wrapper has to be able to tell "the tool returned an object"
/// from "we replaced the tool's return with a cut of it" — this key is that signal,
/// and nothing else in the codebase uses it.
const SPILL_ENVELOPE: &str = "__prismToolOutputSpill";

/// A cut tool return, as it travels in place of the tool's own return (see
/// [`SpilledToolOutput::into_value`]).
#[derive(Debug, Clone, PartialEq)]
pub struct SpilledToolOutput {
    /// The model-facing result: head + notice + tail. Not a sample of the real
    /// thing — this *is* what the model reads and what history stores. `raw` is the
    /// secondary copy, kept only for consumers that need the tool's own shape.
    pub text: String,
    pub truncation: ToolOutputTruncation,
    /// The tool's untouched return, so no structured consumer loses anything.
    pub raw: Value,
}

/// What a serializer sees: the cut view and its sizes, without the original.
///
/// A tool's return is recorded into the telemetry span as JSON, so without this a
/// trace shows this wrapper instead of a result and carries a second full copy of
/// the payload beside the cut one. Every in-process consumer reads `.raw` and is
/// unaffected.
impl Serialize for SpilledToolOutput {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("SpilledToolOutput", 2)?;
        state.serialize_field("text", &self.text)?;
        state.serialize_field("truncation", &self.truncation)?;
        state.end()
    }
}

impl SpilledToolOutput {
    /// The envelope as a tool's return value: the marker, `text`, `truncation` and
    /// `raw`.
    pub fn into_value(self) -> Value {
        let mut envelope = serde_json::Map::new();
        envelope.insert(SPILL_ENVELOPE.to_string(), Value::Bool(true));
        envelope.insert("text".to_string(), Value::String(self.text));
        envelope.insert(
            "truncation".to_string(),
            serde_json::to_value(&self.truncation).unwrap_or(Value::Null),
        );
        envelope.insert("raw".to_string(), self.raw);
        Value::Object(envelope)
    }

    /// The envelope read back from a tool's return; `None` when it is not one.
    pub fn from_value(output: &Value) -> Option<Self> {
        if !is_spilled_tool_output(output) {
            return None;
        }
        Some(Self {
            text: output.get("text")?.as_str()?.to_string(),
            truncation: serde_json::from_value(output.get("truncation")?.clone()).ok()?,
            raw: output.get("raw").cloned().unwrap_or(Value::Null),
        })
    }
}

/// Whether a tool's return is a cut envelope.
pub fn is_spilled_tool_output(output: &Value) -> bool {
    let Some(candidate) = output.as_object() else {
        return false;
    };
    // The marker alone is not enough. A tool returns whatever it likes, and a plugin
    // or MCP server that happened to emit this key would otherwise have its result
    // read as an envelope — storing an empty output and handing the model an
    // undefined value that fails the SDK's validation and kills the turn with an
    // error traceable to nothing.
    candidate.get(SPILL_ENVELOPE) == Some(&Value::Bool(true))
        && candidate.get("text").is_some_and(Value::is_string)
        && candidate
            .get("truncation")
            .is_some_and(|t| t.is_object() || t.is_array())
}

/// The tool's own return, whether or not it was cut.
pub fn unwrap_tool_output(output: &Value) -> &Value {
    if is_spilled_tool_output(output) {
        output.get("raw").unwrap_or(&Value::Null)
    } else {
        output
    }
}

#[derive(Debug, Clone, Default)]
pub struct ToolOutputCaptureOptions {
    /// Character budget for the model-facing text. Defaults to 30,000.
    pub max_chars: Option<usize>,
    /// Appended to the notice — for channel-specific advice.
    pub extra_guidance: Option<String>,
    /// Save the whole output so it can be read back (default on). Off for a call
    /// that only needs the tools block built the same way, and never executes
    /// anything.
    pub spill: Option<bool>,
    /// The thread's workspace, so the saved copy is where that thread's shell reads.
    pub workspace_root: Option<String>,
}

/// Render a tool result for a model, and save the whole thing when it does not fit.
///
/// The one place a saved-copy id is minted. It has to be minted here rather than
/// where the result is persisted, because the id has to appear in the text the model
/// reads *and* in the record stored for later — mint it twice and the model is told
/// one id while another is on disk; mint it at replay and every turn writes a new
/// copy and breaks the prompt-cache prefix.
///
/// A failed save is logged and swallowed. A broken data dir should cost the agent
/// the ability to read the middle back, never the turn.
pub async fn render_and_spill(
    result: &Value,
    options: &ToolOutputCaptureOptions,
    tool_name: Option<&str>,
) -> RenderedToolResult {
    let max_chars = options.max_chars.unwrap_or(DEFAULT_MAX_CHARS);
    let text = stringify_tool_output(result);
    let length = len16(&text);
    if length <= max_chars + PASSTHROUGH_SLACK {
        return RenderedToolResult {
            text,
            truncation: None,
        };
    }

    let tool_name = tool_name.unwrap_or("tool");
    log_warn!(
        "[ToolOutput] {} result truncated: kept {} content chars of {}",
        tool_name,
        max_chars,
        length
    );

    let mut spill: Option<SpillResult> = None;
    if options.spill != Some(false) {
        match write_tool_output(&text, options.workspace_root.as_deref()).await {
            Ok(saved) => spill = Some(saved),
            Err(err) => {
                log_warn!(
                    json!({ "err": crate::lib::log_redaction::err_json(&err) }),
                    "[ToolOutput] could not save the full {} result; the omitted middle is unrecoverable for this call",
                    tool_name
                );
            }
        }
    }

    let prior_omitted = sum_prior_omitted(&text);
    let truncation = ToolOutputTruncation {
        total_chars: (prior_omitted + length as i64) as _,
        kept_chars: max_chars as _,
        omitted_chars: (prior_omitted + (length as i64 - max_chars as i64)) as _,
        spill_id: spill.as_ref().map(|spill| spill.id.clone()),
    };

    RenderedToolResult {
        text: cut_head_tail(
            &text,
            max_chars,
            options.extra_guidance.as_deref(),
            prior_omitted,
            spill.as_ref(),
        ),
        truncation: Some(truncation),
    }
}

/// Cap every tool's result and save what does not fit.
///
/// The cut lives in an `execute` wrapper for two reasons. It reaches every tool,
/// whether or not it has its own `to_model_output` hook (every MCP tool has one).
/// And `to_model_output` runs at prompt-conversion time for the *next* step — after
/// the current step has already been recorded — so a saved-copy id minted there
/// could never reach the stored record.
///
/// A result that fits comes back **unchanged**: `extract_attachment_ids` reads
/// `share_file`'s structured return off the step, and `view_attachment` loads bytes
/// out of its own return inside its own hook. Only an oversized result is replaced,
/// and even then the original travels along in the envelope.
///
/// Per tool:
/// - `execute` (when present): await the original, [`render_and_spill`] it with
///   `options` and the tool's name; return the raw value when nothing was cut, else
///   a [`SpilledToolOutput`] envelope ([`SpilledToolOutput::into_value`]).
/// - `to_model_output`: a tool's own hook is called with
///   [`unwrap_tool_output`] of the output — it must see exactly what it would have
///   seen; an image tool loads bytes out of its return there — and its result goes
///   through [`cap_model_output`] with the envelope's text, or `None` when it was not
///   cut. A tool without a hook gets one answering `{ type: 'text', value }` with the
///   envelope's text, or [`render_tool_result`] of the output with `max_chars` and
///   the tool's name.
pub fn with_tool_output_capture(tools: ToolSet, options: ToolOutputCaptureOptions) -> ToolSet {
    let max_chars = options.max_chars.unwrap_or(DEFAULT_MAX_CHARS);
    let options = Arc::new(ToolOutputCaptureOptions {
        max_chars: Some(max_chars),
        ..options
    });

    tools
        .into_iter()
        .map(|(name, original)| {
            let execute = original.execute.clone().map(|execute| {
                let options = options.clone();
                let tool_name = name.clone();
                let wrapped: ToolExecuteFunction = Arc::new(move |args, execution| {
                    let execute = execute.clone();
                    let options = options.clone();
                    let tool_name = tool_name.clone();
                    Box::pin(async move {
                        let raw = execute(args, execution).await?;
                        let rendered = render_and_spill(&raw, &options, Some(&tool_name)).await;
                        let Some(truncation) = rendered.truncation else {
                            return Ok(raw);
                        };
                        Ok(SpilledToolOutput {
                            text: rendered.text,
                            truncation,
                            raw,
                        }
                        .into_value())
                    })
                });
                wrapped
            });

            let to_model_output: ToModelOutputFunction = match original.to_model_output.clone() {
                Some(own) => Arc::new(move |opts: ToModelOutputOptions| {
                    let own = own.clone();
                    Box::pin(async move {
                        // The tool's own hook must see exactly what it would have
                        // seen: an image tool loads bytes out of its return here, and
                        // a truncated envelope would be meaningless to it.
                        let cut_text = SpilledToolOutput::from_value(&opts.output).map(|s| s.text);
                        let inner = own(ToModelOutputOptions {
                            output: unwrap_tool_output(&opts.output).clone(),
                            ..opts
                        })
                        .await?;
                        Ok(cap_model_output(inner, cut_text.as_deref()))
                    })
                }),
                None => {
                    let tool_name = name.clone();
                    Arc::new(move |opts: ToModelOutputOptions| {
                        let tool_name = tool_name.clone();
                        Box::pin(async move {
                            let value = match SpilledToolOutput::from_value(&opts.output) {
                                Some(spilled) => spilled.text,
                                None => render_tool_result(
                                    &opts.output,
                                    &RenderToolResultOptions {
                                        max_chars: Some(max_chars),
                                        tool_name: Some(tool_name),
                                        ..Default::default()
                                    },
                                ),
                            };
                            Ok(ToolResultOutput::text(value))
                        })
                    })
                }
            };

            (
                name,
                Tool {
                    execute,
                    to_model_output: Some(to_model_output),
                    ..original
                },
            )
        })
        .collect()
}

/// Any shape a tool's own `to_model_output` may return: the AI SDK's tool result
/// output.
pub type ToolModelOutput = ToolResultOutput;

/// Put the cut view into whatever shape a tool's own hook returned.
///
/// `cut_text` is `None` when nothing was cut, and then the hook's output is passed
/// through untouched — the common case, and the one that keeps images and structured
/// returns working exactly as before.
///
/// Non-text parts are never cut. Slicing base64 in half produces a corrupt image
/// rather than a smaller one, and image size is already bounded where images are
/// made.
pub fn cap_model_output(inner: ToolModelOutput, cut_text: Option<&str>) -> ToolModelOutput {
    let Some(cut_text) = cut_text else {
        return inner;
    };
    let Ok(value) = serde_json::to_value(&inner) else {
        return inner;
    };
    serde_json::from_value(cap_model_output_value(&value, cut_text)).unwrap_or(inner)
}

/// [`cap_model_output`] on the output's JSON form (`{ type, value }`).
pub fn cap_model_output_value(inner: &Value, cut_text: &str) -> Value {
    match inner.get("type").and_then(Value::as_str) {
        Some("text") | Some("json") => json!({ "type": "text", "value": cut_text }),
        Some("error-text") | Some("error-json") => {
            json!({ "type": "error-text", "value": cut_text })
        }
        Some("content") => {
            let mut parts = vec![json!({ "type": "text", "text": cut_text })];
            if let Some(items) = inner.get("value").and_then(Value::as_array) {
                parts.extend(
                    items
                        .iter()
                        .filter(|part| part.get("type").and_then(Value::as_str) != Some("text"))
                        .cloned(),
                );
            }
            json!({ "type": "content", "value": parts })
        }
        _ => inner.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passes_a_result_that_fits_unchanged() {
        let rendered =
            render_tool_result_detailed(&json!("short"), &RenderToolResultOptions::default());
        assert_eq!(rendered.text, "short");
        assert!(rendered.truncation.is_none());
    }

    #[test]
    fn joins_the_text_parts_of_an_mcp_result() {
        let output = json!({ "content": [{ "type": "text", "text": "a" }, { "type": "image" }, { "type": "text", "text": "b" }] });
        assert_eq!(stringify_tool_output(&output), "a\nb");
        assert_eq!(stringify_tool_output(&json!({ "n": 3 })), r#"{"n":3}"#);
    }

    #[test]
    fn keeps_head_and_tail_and_reports_the_accumulated_omission() {
        let text = "x".repeat(2000);
        let cut = truncate_head_tail(&text, 1000, None);
        assert!(cut.starts_with(&"x".repeat(800)));
        assert!(cut.contains(
            "[INCOMPLETE OUTPUT — 1000 chars omitted from the middle; 2000 chars total."
        ));
        assert_eq!(sum_prior_omitted(&cut), 1000);
    }

    #[test]
    fn caps_a_hook_output_in_its_own_shape() {
        let content = json!({ "type": "content", "value": [{ "type": "text", "text": "long" }, { "type": "image", "data": "b64" }] });
        assert_eq!(
            cap_model_output_value(&content, "cut"),
            json!({ "type": "content", "value": [{ "type": "text", "text": "cut" }, { "type": "image", "data": "b64" }] })
        );
        assert_eq!(
            cap_model_output_value(&json!({ "type": "error-json", "value": {} }), "cut")["type"],
            "error-text"
        );
    }

    #[test]
    fn recognises_only_a_whole_envelope() {
        let envelope =
            json!({ "__prismToolOutputSpill": true, "text": "t", "truncation": {}, "raw": 1 });
        assert!(is_spilled_tool_output(&envelope));
        assert_eq!(unwrap_tool_output(&envelope), &json!(1));
        assert!(!is_spilled_tool_output(
            &json!({ "__prismToolOutputSpill": true })
        ));
    }
}

#[cfg(test)]
mod capture_tests {
    use super::*;
    use crate::ai::{ToModelOutputOptions, ToolExecutionOptions, execute_fn, to_model_output_fn};

    fn tool_with(result: Value) -> ToolSet {
        let mut tools = ToolSet::new();
        tools.insert(
            "myTool".into(),
            Tool {
                description: Some("my description".into()),
                execute: Some(execute_fn(move |_input, _options| {
                    let result = result.clone();
                    async move { Ok(result) }
                })),
                ..Default::default()
            },
        );
        tools
    }

    fn capture(tools: ToolSet, max_chars: usize) -> ToolSet {
        with_tool_output_capture(
            tools,
            ToolOutputCaptureOptions {
                max_chars: Some(max_chars),
                spill: Some(false),
                ..Default::default()
            },
        )
    }

    async fn run(tools: &ToolSet, name: &str) -> Value {
        let execute = tools[name].execute.clone().unwrap();
        execute(json!({}), ToolExecutionOptions::default())
            .await
            .unwrap()
    }

    async fn model_view(tools: &ToolSet, name: &str, output: Value) -> Value {
        let hook = tools[name].to_model_output.clone().unwrap();
        let view = hook(ToModelOutputOptions {
            tool_call_id: "call-1".into(),
            input: json!({}),
            output,
        })
        .await
        .unwrap();
        serde_json::to_value(view).unwrap()
    }

    #[tokio::test]
    async fn returns_a_result_that_fits_unchanged() {
        let raw = json!({ "success": true, "attachmentId": "att-1" });
        let tools = capture(tool_with(raw.clone()), 1000);
        assert_eq!(run(&tools, "myTool").await, raw);
    }

    #[tokio::test]
    async fn shows_a_result_that_fits_unchanged_to_the_model() {
        let tools = capture(tool_with(json!("short output")), 1000);
        assert_eq!(
            model_view(&tools, "myTool", json!("short output")).await,
            json!({ "type": "text", "value": "short output" })
        );
    }

    #[tokio::test]
    async fn replaces_an_oversized_result_with_a_cut_that_keeps_the_original() {
        let raw = json!("Z".repeat(50_000));
        let tools = capture(tool_with(raw.clone()), 1000);
        let out = run(&tools, "myTool").await;
        assert!(is_spilled_tool_output(&out));
        assert_eq!(unwrap_tool_output(&out), &raw);
        let text = out["text"].as_str().unwrap();
        assert!(text.contains("[INCOMPLETE OUTPUT"));
        assert!(text.len() < 50_000);

        // The model is shown the cut minted at execute time.
        assert_eq!(
            model_view(&tools, "myTool", out.clone()).await,
            json!({ "type": "text", "value": text })
        );
    }

    #[tokio::test]
    async fn cuts_an_mcp_result_down_to_its_text() {
        let mcp = json!({ "content": [{ "type": "text", "text": "POD".repeat(500) }] });
        let tools = capture(tool_with(mcp), 50);
        let out = run(&tools, "myTool").await;
        assert!(out["text"].as_str().unwrap().contains("[INCOMPLETE OUTPUT"));
    }

    #[tokio::test]
    async fn caps_a_tool_that_brings_its_own_model_output() {
        let raw = json!({ "content": [{ "type": "text", "text": "POD".repeat(500) }] });
        let mut tools = tool_with(raw.clone());
        let seen: Arc<parking_lot::Mutex<Option<Value>>> = Arc::default();
        let seen_in = seen.clone();
        tools["myTool"].to_model_output = Some(to_model_output_fn(move |options| {
            let seen_in = seen_in.clone();
            async move {
                *seen_in.lock() = Some(options.output.clone());
                Ok(serde_json::from_value(json!({
                    "type": "content",
                    "value": [
                        { "type": "text", "text": "POD".repeat(500) },
                        { "type": "image-data", "data": "abc123", "mediaType": "image/png" },
                    ],
                }))?)
            }
        }));
        let tools = capture(tools, 50);
        let out = run(&tools, "myTool").await;
        let view = model_view(&tools, "myTool", out).await;

        // The tool's own hook still saw its own return, not the envelope.
        assert_eq!(seen.lock().as_ref(), Some(&raw));
        assert_eq!(view["type"], "content");
        let parts = view["value"].as_array().unwrap();
        assert!(
            parts[0]["text"]
                .as_str()
                .unwrap()
                .contains("[INCOMPLETE OUTPUT")
        );
        assert!(parts[0]["text"].as_str().unwrap().len() < 1500);
        // A non-text part is never cut.
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[1]["data"], "abc123");
    }

    #[tokio::test]
    async fn leaves_an_image_only_result_alone() {
        let raw = json!({ "content": [{ "type": "image", "data": "x".repeat(60_000), "mimeType": "image/png" }] });
        let tools = capture(tool_with(raw.clone()), 50);
        assert_eq!(run(&tools, "myTool").await, raw);
    }

    #[tokio::test]
    async fn caps_the_model_view_of_a_tool_with_no_execute() {
        let mut tools = ToolSet::new();
        tools.insert(
            "provided".into(),
            Tool {
                description: Some("provider-defined".into()),
                ..Default::default()
            },
        );
        let tools = capture(tools, 100);
        assert!(tools["provided"].execute.is_none());
        let view = model_view(&tools, "provided", json!("Z".repeat(50_000))).await;
        assert!(
            view["value"]
                .as_str()
                .unwrap()
                .contains("[INCOMPLETE OUTPUT")
        );
    }

    #[tokio::test]
    async fn does_not_mistake_a_result_with_the_marker_for_a_cut_one() {
        let impostor = json!({ "__prismToolOutputSpill": true, "somethingElse": 1 });
        assert!(!is_spilled_tool_output(&impostor));
        let tools = capture(tool_with(impostor), 1000);
        let out = run(&tools, "myTool").await;
        let view = model_view(&tools, "myTool", out).await;
        assert!(view["value"].as_str().unwrap().contains("somethingElse"));
    }

    #[test]
    fn keeps_the_tools_own_properties() {
        let tools = capture(tool_with(json!("x")), 1000);
        assert_eq!(
            tools["myTool"].description.as_deref(),
            Some("my description")
        );
    }

    #[test]
    fn serializes_the_envelope_as_the_cut_view_alone() {
        let spilled = SpilledToolOutput {
            text: "cut".into(),
            truncation: ToolOutputTruncation {
                total_chars: 10,
                kept_chars: 5,
                omitted_chars: 5,
                spill_id: None,
            },
            raw: json!("ONLY-IN-THE-RAW"),
        };
        let serialized = serde_json::to_string(&spilled).unwrap();
        assert!(!serialized.contains("ONLY-IN-THE-RAW"));
        assert_eq!(
            serde_json::from_str::<Value>(&serialized).unwrap(),
            json!({ "text": "cut", "truncation": { "totalChars": 10, "keptChars": 5, "omittedChars": 5 } })
        );
    }
}
