use super::*;
use crate::ai::{
    Instructions, LanguageModel, LanguageModelV4CallOptions, LanguageModelV4GenerateResult,
};
use crate::lib::llm_providers::llm_provider::{ClassificationSamplingParams, provider_options};
use async_trait::async_trait;
use tokio::sync::oneshot;

const VOICES: NameVoices = NameVoices {
    default: "marin",
    man: "cedar",
};

/// The readings stored in `runtime_state`, as one value.
#[derive(Default)]
struct MemoryStore(Mutex<Option<String>>);

impl ReadingStore for Arc<MemoryStore> {
    fn get(&self) -> BoxFuture<'static, anyhow::Result<Option<String>>> {
        let value = self.0.lock().clone();
        async move { Ok(value) }.boxed()
    }

    fn set(&self, value: String) -> BoxFuture<'static, anyhow::Result<()>> {
        *self.0.lock() = Some(value);
        async { Ok(()) }.boxed()
    }
}

/// The names the model was asked to read, in order.
type Asked = Arc<Mutex<Vec<String>>>;

struct Fixture {
    voices: Arc<AgentVoices>,
    store: Arc<MemoryStore>,
    asked: Asked,
}

impl Fixture {
    /// The readings stored in `runtime_state`.
    fn stored(&self) -> serde_json::Value {
        serde_json::from_str(self.store.0.lock().as_deref().unwrap_or("{}")).unwrap()
    }

    fn calls(&self) -> usize {
        self.asked.lock().len()
    }
}

/// An `AgentVoices` whose model answers each name with `answer(name)`.
fn fixture_with(
    configured: &str,
    realtime_configured: fn() -> bool,
    answer: impl Fn(&str) -> BoxFuture<'static, anyhow::Result<String>> + Send + Sync + 'static,
) -> Fixture {
    let store = Arc::new(MemoryStore::default());
    let asked: Asked = Arc::default();
    let seen = asked.clone();
    let read_name: ReadName = Arc::new(move |name: String| {
        seen.lock().push(name.clone());
        answer(&name)
    });
    let voices = Arc::new(AgentVoices::new(
        configured.to_string(),
        VOICES,
        realtime_configured,
        read_name,
        Arc::new(store.clone()),
    ));
    Fixture {
        voices,
        store,
        asked,
    }
}

/// Answers `text` for every name.
fn answers(text: &'static str) -> Fixture {
    fixture_with(
        AUTO_VOICE,
        || true,
        move |_| async move { Ok(text.to_string()) }.boxed(),
    )
}

fn voice(voice: &str, source: VoiceSource) -> AgentVoice {
    AgentVoice {
        voice: voice.to_string(),
        source,
    }
}

#[tokio::test]
async fn speaks_every_call_with_a_voice_that_is_set_without_reading_the_name() {
    let f = fixture_with("ash", || true, |_| async { Ok("man".to_string()) }.boxed());
    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("ash", VoiceSource::Configured)
    );
    assert_eq!(f.calls(), 0);
}

#[tokio::test]
async fn speaks_a_name_with_the_voice_of_its_reading() {
    for (answer, expected) in [("woman", "marin"), ("man", "cedar"), ("unclear", "marin")] {
        let f = answers(answer);
        assert_eq!(
            f.voices.voice_for_agent("Max").await,
            voice(expected, VoiceSource::Name),
            "{answer}"
        );
    }
}

#[tokio::test]
async fn sends_the_name_trimmed() {
    let f = answers("man");
    f.voices.voice_for_agent("  Max ").await;
    assert_eq!(*f.asked.lock(), ["Max"]);
}

/// A model nothing calls.
struct Unused;

#[async_trait]
impl LanguageModel for Unused {
    fn provider(&self) -> &str {
        "mock-provider"
    }

    fn model_id(&self) -> &str {
        "classifier"
    }

    async fn do_generate(
        &self,
        _options: LanguageModelV4CallOptions,
    ) -> anyhow::Result<LanguageModelV4GenerateResult> {
        anyhow::bail!("no model in this test")
    }
}

#[test]
fn sends_the_name_as_data_with_the_prompt_as_the_agent_voice_call() {
    let gate = GateRequest {
        model: Arc::new(Unused),
        provider_options: provider_options(json!({})),
        min_output_tokens: 0,
        sampling_params: ClassificationSamplingParams { temperature: None },
    };
    let (meta, params) = reading_request(gate, "Max");
    assert_eq!(meta, ModelCallMeta::new(LlmCallPurpose::AgentVoice));
    assert_eq!(
        params.system,
        Some(Instructions::Text(NAME_READING_PROMPT.to_string()))
    );
    assert_eq!(
        serde_json::to_value(params.messages.unwrap()).unwrap(),
        json!([{ "role": "user", "content": "<name>\nMax\n</name>" }])
    );
    assert_eq!(params.max_output_tokens, Some(16));
    assert_eq!(params.telemetry.unwrap().is_enabled, Some(false));
}

#[tokio::test]
async fn reads_a_name_once_and_stores_the_reading() {
    let f = answers("man");
    f.voices.voice_for_agent("Max").await;
    f.voices.voice_for_agent("Max").await;
    assert_eq!(f.calls(), 1);
    assert_eq!(f.stored(), json!({ "Max": "man" }));
}

#[tokio::test]
async fn reads_the_name_again_when_its_stored_reading_is_gone() {
    let f = answers("man");
    f.voices.voice_for_agent("Max").await;
    *f.store.0.lock() = None;
    f.voices.voice_for_agent("Max").await;
    assert_eq!(f.calls(), 2);
    assert_eq!(f.stored(), json!({ "Max": "man" }));
}

#[tokio::test]
async fn keeps_both_readings_when_two_names_are_read_at_once() {
    let f = fixture_with(
        AUTO_VOICE,
        || true,
        |name| {
            let answer = if name.contains("Max") { "man" } else { "woman" };
            async move { Ok(answer.to_string()) }.boxed()
        },
    );
    tokio::join!(
        f.voices.voice_for_agent("Max"),
        f.voices.voice_for_agent("Maya")
    );
    assert_eq!(f.stored(), json!({ "Max": "man", "Maya": "woman" }));
}

#[tokio::test]
async fn takes_a_stored_reading_after_a_restart_without_reading_the_name_again() {
    let f = answers("woman");
    *f.store.0.lock() = Some(json!({ "Max": "man" }).to_string());
    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("cedar", VoiceSource::Name)
    );
    assert_eq!(f.calls(), 0);
}

#[tokio::test]
async fn reads_the_name_when_what_is_stored_cannot_be_read() {
    let f = answers("woman");
    *f.store.0.lock() = Some("{not json".to_string());
    assert_eq!(
        f.voices.voice_for_agent("Maya").await,
        voice("marin", VoiceSource::Name)
    );
    assert_eq!(f.stored(), json!({ "Maya": "woman" }));
}

#[tokio::test(start_paused = true)]
async fn speaks_with_the_default_voice_while_the_name_is_still_being_read() {
    let (answer, answered) = oneshot::channel::<String>();
    let answered = Arc::new(Mutex::new(Some(answered)));
    let f = fixture_with(
        AUTO_VOICE,
        || true,
        move |_| {
            let answered = answered.lock().take().expect("one reading");
            async move { Ok(answered.await?) }.boxed()
        },
    );

    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("marin", VoiceSource::Fallback)
    );

    answer.send("man".to_string()).unwrap();
    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("cedar", VoiceSource::Name)
    );
    assert_eq!(f.calls(), 1);
}

#[tokio::test]
async fn speaks_with_the_default_voice_when_the_model_fails_and_reads_the_name_again_next_time() {
    let failed = Arc::new(Mutex::new(false));
    let f = fixture_with(
        AUTO_VOICE,
        || true,
        move |_| {
            let first = !std::mem::replace(&mut *failed.lock(), true);
            async move {
                if first {
                    anyhow::bail!("throttled");
                }
                Ok("man".to_string())
            }
            .boxed()
        },
    );
    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("marin", VoiceSource::Fallback)
    );
    assert_eq!(f.stored(), json!({}));
    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("cedar", VoiceSource::Name)
    );
    assert_eq!(f.calls(), 2);
}

#[tokio::test]
async fn speaks_a_name_outside_the_rule_for_names_with_the_default_voice_without_reading_it() {
    let f = answers("man");
    assert_eq!(
        f.voices.voice_for_agent("<b>Max</b>").await,
        voice("marin", VoiceSource::Fallback)
    );
    assert_eq!(f.calls(), 0);
}

#[tokio::test]
async fn warm_voice_reads_a_new_name_ahead_of_the_next_call() {
    let f = answers("man");
    f.voices.warm_voice("Max");
    assert_eq!(
        f.voices.voice_for_agent("Max").await,
        voice("cedar", VoiceSource::Name)
    );
    assert_eq!(f.calls(), 1);
}

#[tokio::test]
async fn warm_voice_reads_nothing_when_a_voice_is_set() {
    let f = fixture_with("ash", || true, |_| async { Ok("man".to_string()) }.boxed());
    f.voices.warm_voice("Max");
    tokio::task::yield_now().await;
    assert_eq!(f.calls(), 0);
}

#[tokio::test]
async fn warm_voice_reads_nothing_when_the_agent_cannot_open_a_voice_session() {
    let f = fixture_with(
        AUTO_VOICE,
        || false,
        |_| async { Ok("man".to_string()) }.boxed(),
    );
    f.voices.warm_voice("Max");
    tokio::task::yield_now().await;
    assert_eq!(f.calls(), 0);
}

#[test]
fn reads_an_answer_as_a_reading() {
    for (answer, reading) in [
        ("woman", NameReading::Woman),
        ("Man.", NameReading::Man),
        ("**man**", NameReading::Man),
        ("- woman", NameReading::Woman),
        ("Not man", NameReading::Unclear),
        ("\"woman\"", NameReading::Woman),
        (" woman\n", NameReading::Woman),
        ("unclear", NameReading::Unclear),
        ("male", NameReading::Unclear),
        ("I think man", NameReading::Unclear),
        ("", NameReading::Unclear),
    ] {
        assert_eq!(reading_of_answer(answer), reading, "{answer:?}");
    }
}
