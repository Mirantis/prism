//! Records the tokens a Realtime session reports: on every `response.done`, and on
//! every finished input transcription.

use serde_json::Value;

use crate::lib::spend_context::{SpendContext, SpendSource, SpendSourceKind};
use crate::services::llm_call_service::{
    CallTokens, LLM_CALL_SERVICE, LlmCallPurpose, RecordTokensInput,
};

/// What a Realtime session serves.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RealtimePurpose {
    VoiceChat,
    Meeting,
    Dictation,
}

impl RealtimePurpose {
    fn call_purpose(self) -> LlmCallPurpose {
        match self {
            Self::VoiceChat => LlmCallPurpose::VoiceChat,
            Self::Meeting => LlmCallPurpose::Meeting,
            Self::Dictation => LlmCallPurpose::Dictation,
        }
    }

    fn source_kind(self) -> SpendSourceKind {
        match self {
            Self::VoiceChat => SpendSourceKind::VoiceChat,
            Self::Meeting => SpendSourceKind::Meeting,
            Self::Dictation => SpendSourceKind::Dictation,
        }
    }
}

/// Where a session's calls are spent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RealtimeSpend {
    pub purpose: RealtimePurpose,
    /// One id for the whole session, so a session's spend reads as one request.
    pub request_id: String,
    pub thread_id: Option<String>,
}

impl RealtimeSpend {
    /// A new session's spend, under a request id of its own.
    pub fn new(purpose: RealtimePurpose, thread_id: Option<String>) -> RealtimeSpend {
        RealtimeSpend {
            purpose,
            request_id: uuid::Uuid::new_v4().to_string(),
            thread_id,
        }
    }

    /// The spend context the session's tools run in, so the model calls a tool
    /// makes (a coding-agent task, a subagent) are spent on the session.
    pub fn context(&self) -> SpendContext {
        SpendContext {
            request_id: self.request_id.clone(),
            thread_id: self.thread_id.clone(),
            source: Some(SpendSource::of(self.purpose.source_kind())),
        }
    }
}

/// The token columns of a Realtime event's `usage` object, with the audio and the
/// cached parts kept apart so each is priced at its own rate. A duration-billed
/// transcription reports seconds, not tokens, and has none.
fn tokens_of(usage: Option<&Value>) -> Option<CallTokens> {
    let usage = usage?;
    let count = |value: Option<&Value>| value.and_then(Value::as_f64).map(|n| n as i64);
    let input = count(usage.get("input_tokens"))?;
    let output = count(usage.get("output_tokens")).unwrap_or(0);
    let details = usage.get("input_token_details");
    let cached = count(details.and_then(|d| d.get("cached_tokens"))).unwrap_or(0);
    let audio = count(details.and_then(|d| d.get("audio_tokens"))).unwrap_or(0);
    let cached_audio = count(
        details
            .and_then(|d| d.get("cached_tokens_details"))
            .and_then(|d| d.get("audio_tokens")),
    )
    .unwrap_or(0);
    Some(CallTokens {
        total_tokens: count(usage.get("total_tokens")).unwrap_or(input + output),
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cached,
        cache_write_tokens: 0,
        no_cache_tokens: (input - cached).max(0),
        long_cache_write_tokens: None,
        audio_input_tokens: Some((audio - cached_audio).max(0)),
        audio_output_tokens: Some(
            count(
                usage
                    .get("output_token_details")
                    .and_then(|d| d.get("audio_tokens")),
            )
            .unwrap_or(0),
        ),
    })
}

fn usage_input(spend: &RealtimeSpend, model: &str, usage: Option<&Value>) -> RecordTokensInput {
    RecordTokensInput {
        thread_id: spend.thread_id.clone(),
        request_id: Some(spend.request_id.clone()),
        source: Some(SpendSource::of(spend.purpose.source_kind())),
        ..RecordTokensInput::new(spend.purpose.call_purpose(), model, tokens_of(usage))
    }
}

/// Record one Realtime call of `model`. A call that reported no tokens is a row with no cost.
pub fn record_realtime_usage(spend: &RealtimeSpend, model: &str, usage: Option<&Value>) {
    LLM_CALL_SERVICE.record_tokens(usage_input(spend, model, usage));
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn splits_the_audio_and_the_cached_tokens_of_a_response() {
        let spend = RealtimeSpend {
            purpose: RealtimePurpose::VoiceChat,
            request_id: "call-1".into(),
            thread_id: Some("thread-1".into()),
        };
        let usage = json!({
            "total_tokens": 1300,
            "input_tokens": 1000,
            "output_tokens": 300,
            "input_token_details": {
                "text_tokens": 300,
                "audio_tokens": 700,
                "cached_tokens": 200,
                "cached_tokens_details": { "text_tokens": 100, "audio_tokens": 100 },
            },
            "output_token_details": { "text_tokens": 50, "audio_tokens": 250 },
        });
        let input = usage_input(&spend, "gpt-realtime-2.1", Some(&usage));
        assert_eq!(input.purpose, LlmCallPurpose::VoiceChat);
        assert_eq!(input.model, "gpt-realtime-2.1");
        assert_eq!(input.thread_id.as_deref(), Some("thread-1"));
        assert_eq!(input.request_id.as_deref(), Some("call-1"));
        assert_eq!(
            input.source,
            Some(SpendSource::of(SpendSourceKind::VoiceChat))
        );
        assert_eq!(
            input.tokens,
            Some(CallTokens {
                total_tokens: 1300,
                input_tokens: 1000,
                output_tokens: 300,
                cache_read_tokens: 200,
                cache_write_tokens: 0,
                no_cache_tokens: 800,
                long_cache_write_tokens: None,
                audio_input_tokens: Some(600),
                audio_output_tokens: Some(250),
            })
        );
    }

    #[test]
    fn records_a_transcription_billed_by_duration_as_a_call_with_no_tokens() {
        let spend = RealtimeSpend {
            purpose: RealtimePurpose::Dictation,
            request_id: "dictation-1".into(),
            thread_id: None,
        };
        let input = usage_input(
            &spend,
            "gpt-live-transcribe",
            Some(&json!({ "type": "duration", "seconds": 4 })),
        );
        assert_eq!(input.purpose, LlmCallPurpose::Dictation);
        assert_eq!(input.tokens, None);
    }
}
