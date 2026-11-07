//! Thread title generation (channel-agnostic).
//!
//! The synchronous title (the conversation service's `add_message`) is just the
//! first 3 words of the user's message, truncated. This upgrades it to a proper
//! short title via the classification model — a direct LLM inference call, no
//! tools and no `invoke`, mirroring the heartbeat classification gate.
//!
//! `on_first_user_message` owns the placeholder → upgrade lifecycle and announces
//! each title on `events`. It is triggered from the conversation engine (the one
//! path every channel goes through), so nothing here knows about a transport;
//! transports subscribe to `events` to push updates. Fail-open: a generation
//! failure just leaves the placeholder in place.

use std::sync::{Arc, LazyLock};

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::{FinishReason, GenerateTextOptions, Instructions, ModelMessage};
use crate::lib::classification::get_gate_request;
use crate::lib::log_redaction::err_json;
use crate::lib::model_call::{ModelCallMeta, call_model};
use crate::lib::telemetry::langfuse_telemetry;
use crate::services::conversation_service::CONVERSATION_SERVICE;
use crate::services::llm_call_service::LlmCallPurpose;
use crate::support::js;
use crate::{log_error, log_info};

/// The length of the title the model is asked for.
const TITLE_WORDS: usize = 3;

/// The longest title kept. The model often writes one word more than it is asked
/// for, and cutting that word leaves a fragment such as "Billing API Test".
const MAX_TITLE_WORDS: usize = TITLE_WORDS + 1;

const SYSTEM_PROMPT: &str = "You name chat conversations. You get the first message of a conversation and write a short title that names its topic. You do not answer or carry out the message. Write only the title on one line, with no quotes, label or formatting.";

/// A thread's title was (re)set — emitted as `change` on the service's `events`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadTitleChange {
    pub user_id: String,
    pub thread_id: String,
    pub title: String,
}

/// Receives each `change`.
pub type ThreadTitleListener = Arc<dyn Fn(&ThreadTitleChange) + Send + Sync>;

/// The `change` events: a thread's title was (re)set.
#[derive(Default)]
pub struct ThreadTitleEvents {
    change: RwLock<Vec<ThreadTitleListener>>,
}

impl ThreadTitleEvents {
    /// Call `listener` with every title change from now on.
    pub fn on_change(&self, listener: impl Fn(&ThreadTitleChange) + Send + Sync + 'static) {
        self.change.write().push(Arc::new(listener));
    }

    /// Hand `change` to every listener, synchronously and in subscription order.
    pub fn emit_change(&self, change: &ThreadTitleChange) {
        let listeners = self.change.read().clone();
        for listener in listeners {
            listener(change);
        }
    }
}

/// Keep the first non-empty line, strip wrapping quotes and trailing punctuation,
/// and keep at most `MAX_TITLE_WORDS` words. A title is one line, so a second line
/// is the start of an answer and never part of the title.
fn clamp_title(raw: &str) -> Option<String> {
    let first_line = raw
        .split('\n')
        .find(|line| !js::trim(line).is_empty())
        .unwrap_or("");
    let cleaned = js::trim(
        js::trim(first_line)
            .trim_start_matches(['"', '\'', '`'])
            .trim_end_matches(['"', '\'', '`', '.', '!', '?']),
    );
    let title = cleaned
        .split(js::is_js_whitespace)
        .filter(|word| !word.is_empty())
        .take(MAX_TITLE_WORDS)
        .collect::<Vec<_>>()
        .join(" ");
    if title.is_empty() { None } else { Some(title) }
}

/// The user message of the title request. The task follows the message: sent
/// alone, the message reads as a request to the model, which then answers it
/// instead of naming it. A message that contains `</message>` ends the tag early;
/// at worst its title is odd.
fn title_request(text: &str) -> String {
    format!(
        "<message>\n{text}\n</message>\n\nWrite a title of at most {TITLE_WORDS} words for this message, in the language the message is written in."
    )
}

/// Ask the classification model for a short title for `message`. Returns the
/// clamped title, or `None` when the message is empty, the model declined it
/// (finish reason `content-filter`), or the call fails.
async fn generate_thread_title(thread_id: &str, message: &str) -> Option<String> {
    let text = js::trim(message);
    if text.is_empty() {
        return None;
    }
    #[cfg(test)]
    if let Some(generate) = testing::GENERATE.read().clone() {
        return generate(text).and_then(|raw| clamp_title(&raw));
    }
    let result = async {
        let gate = get_gate_request()?;
        let mut params = GenerateTextOptions::new(gate.model);
        params.provider_options = Some(gate.provider_options);
        params.system = Some(Instructions::from(SYSTEM_PROMPT));
        params.messages = Some(vec![ModelMessage::user(title_request(text))]);
        params.max_output_tokens = Some(24);
        params.temperature = gate.sampling_params.temperature;
        let telemetry = langfuse_telemetry("thread-title", None, None);
        params.telemetry = telemetry.experimental_telemetry;
        if let Some(context) = telemetry.runtime_context {
            for (key, value) in context {
                params.runtime_context.insert(key, Value::String(value));
            }
        }
        let mut meta = ModelCallMeta::new(LlmCallPurpose::ThreadTitle);
        meta.thread_id = Some(thread_id.to_string());
        call_model(meta, params).await
    }
    .await;
    match result {
        // The title model can decline the message it was asked to summarize. The
        // finish reason is what says so: the text may be empty or may be the
        // refusal sentence, and only the second shape produced a title — cut to a
        // few words and saved, a thread ended up named "I can't help".
        Ok(result) if result.finish_reason() == FinishReason::ContentFilter => None,
        Ok(result) => clamp_title(&result.text()),
        Err(error) => {
            log_error!(
                json!({ "err": err_json(&error) }),
                "[ThreadTitle] generation failed"
            );
            None
        }
    }
}

pub struct ThreadTitleService {
    /// Emits a [`ThreadTitleChange`] whenever a thread title is (re)set — first
    /// the placeholder, then the LLM upgrade. Transports (e.g. the WS gateway)
    /// subscribe to push the update to clients; the generation here stays
    /// channel-agnostic.
    pub events: ThreadTitleEvents,
}

impl ThreadTitleService {
    pub fn new() -> Self {
        ThreadTitleService {
            events: ThreadTitleEvents::default(),
        }
    }

    /// React to the first user message that named a thread: announce the
    /// placeholder title immediately, then asynchronously upgrade it to a proper
    /// short title and announce that too. Fire-and-forget — never blocks the
    /// turn; a generation failure just keeps the placeholder.
    pub fn on_first_user_message(
        &'static self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        message: &str,
        placeholder_title: &str,
    ) {
        self.events.emit_change(&ThreadTitleChange {
            user_id: user_id.to_string(),
            thread_id: thread_id.to_string(),
            title: placeholder_title.to_string(),
        });
        let (agent_id, user_id, thread_id, message) = (
            agent_id.to_string(),
            user_id.to_string(),
            thread_id.to_string(),
            message.to_string(),
        );
        tokio::spawn(async move {
            match self
                .generate_and_save(&agent_id, &user_id, &thread_id, &message)
                .await
            {
                Ok(Some(title)) => self.events.emit_change(&ThreadTitleChange {
                    user_id,
                    thread_id,
                    title,
                }),
                Ok(None) => {}
                Err(err) => log_error!(
                    json!({ "err": err_json(&err) }),
                    "[ThreadTitle] upgrade failed"
                ),
            }
        });
    }

    /// Generate a short title for the thread's first message and persist it.
    /// Returns the saved title, or `None` when nothing was generated. Fails only
    /// when the title cannot be saved.
    pub async fn generate_and_save(
        &self,
        agent_id: &str,
        user_id: &str,
        thread_id: &str,
        message: &str,
    ) -> anyhow::Result<Option<String>> {
        let Some(title) = generate_thread_title(thread_id, message).await else {
            return Ok(None);
        };
        CONVERSATION_SERVICE
            .update_thread_title(agent_id, user_id, thread_id, &title)
            .await?;
        log_info!(
            "[ThreadTitle] Set thread {} title to \"{}\"",
            thread_id,
            title
        );
        Ok(Some(title))
    }
}

impl Default for ThreadTitleService {
    fn default() -> Self {
        Self::new()
    }
}

pub static THREAD_TITLE_SERVICE: LazyLock<ThreadTitleService> =
    LazyLock::new(ThreadTitleService::new);

/// What tests set in place of the title model.
#[cfg(test)]
pub(crate) mod testing {
    use std::sync::Arc;

    use parking_lot::RwLock;

    /// Answers a title request's message text with the model's raw text, or `None`
    /// for a failed call.
    pub(crate) type Generate = Arc<dyn Fn(&str) -> Option<String> + Send + Sync>;

    pub(crate) static GENERATE: RwLock<Option<Generate>> = RwLock::new(None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_at_most_four_words_of_the_first_line() {
        assert_eq!(
            clamp_title("Database Schema Migration Plan Draft").as_deref(),
            Some("Database Schema Migration Plan")
        );
        // A recorded answer shape: the title, then the start of the postmortem the
        // message asked for.
        assert_eq!(
            clamp_title(
                "Incident Postmortem\n\n**Incident Summary**\nFire alert triggered at 01:12, followed by"
            )
            .as_deref(),
            Some("Incident Postmortem")
        );
    }

    #[test]
    fn strips_wrapping_quotes_and_trailing_punctuation() {
        assert_eq!(
            clamp_title("\"Staging Deploy.\"").as_deref(),
            Some("Staging Deploy")
        );
        assert_eq!(clamp_title("  \".\"  "), None);
    }

    #[test]
    fn puts_the_message_in_tags_and_the_task_after_it() {
        let content = title_request("migrate the authentication layer");
        assert!(content.starts_with("<message>\nmigrate the authentication layer\n</message>\n\n"));
        let last = content.split('\n').next_back().unwrap();
        assert!(last.contains("title"));
        assert!(last.ends_with("in the language the message is written in."));
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn makes_no_call_for_an_empty_message() {
        *testing::GENERATE.write() = Some(Arc::new(|_| panic!("no call for an empty message")));
        let title = THREAD_TITLE_SERVICE
            .generate_and_save("a1", "u1", "t1", "   ")
            .await
            .unwrap();
        *testing::GENERATE.write() = None;
        assert_eq!(title, None);
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn announces_the_placeholder_at_once_and_only_it_when_the_upgrade_fails() {
        let _db = crate::db::testing::test_db();
        *testing::GENERATE.write() = Some(Arc::new(|_| None));
        let changes = Arc::new(parking_lot::Mutex::new(Vec::new()));
        let sink = Arc::clone(&changes);
        THREAD_TITLE_SERVICE
            .events
            .on_change(move |change| sink.lock().push(change.clone()));

        THREAD_TITLE_SERVICE.on_first_user_message("a1", "u1", "t1", "hello there", "hello there");
        // The placeholder is announced before the call returns.
        assert_eq!(
            *changes.lock(),
            vec![ThreadTitleChange {
                user_id: "u1".into(),
                thread_id: "t1".into(),
                title: "hello there".into(),
            }]
        );
        for _ in 0..20 {
            tokio::task::yield_now().await;
        }
        *testing::GENERATE.write() = None;
        assert_eq!(changes.lock().len(), 1);
    }
}
