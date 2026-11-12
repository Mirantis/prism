//! The computer tools: the ones `create_computer_tools` builds, dispatched to the
//! computer each call names (or the run's default), plus `computer_screen`,
//! `computer_help`, `computer_continue` and, in a voice call,
//! `computer_instruct`.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{Arc, LazyLock};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::ai::{
    Tool, ToolExecuteFunction, ToolResultContentPart, ToolResultOutput, ToolSet, execute_fn,
    to_model_output_fn, tool, zod_schema,
};
use crate::lib::tool_output_limiter::{RenderToolResultOptions, render_tool_result};
use crate::services::computer::agent_computer::ModelChannel;
use crate::services::computer::computer::Computer;
use crate::services::computer::computer_access::ComputerUse;
use crate::services::computer::computer_help_service::{
    COMPUTER_HELP_SERVICE, HELP_ANSWER_WAIT_MS, HelpAnswer, HelpStatus, computer_link,
    waits_for_answer,
};
use crate::services::computer::computer_service::COMPUTER_SERVICE;
use crate::services::computer::computer_session::{ComputerSession, Controller, HELD_LOCALLY};
use crate::services::computer::computer_tools::{
    ClickInput, ClickTextInput, ComputerBrowser, ComputerDesktop, ComputerUserScreen,
    DesktopActionResult, DragInput, FindTextInput, FindTextResult, KeyInput, ListElementsInput,
    MoveInput, ScreenLook, ScrollInput, TypeInput, UserScreenResult, WindowActionInput,
    create_computer_tools,
};
use crate::services::computer::remote::remote_computer_service::REMOTE_COMPUTER_SERVICE;
use crate::services::computer::screen_size::{DEFAULT_SCREEN, picture_for};
use crate::services::computer::supported::{has_computer, uses_remote_computers};
use crate::services::conversation_engine_service::{
    CONVERSATION_ENGINE_SERVICE, ChatInput, ChatMetadata,
};
use crate::services::meeting::browser_control::{BrowserCommand, BrowserResult};
use crate::services::message_delivery_service::MESSAGE_DELIVERY_SERVICE;
use crate::support::js;

pub const ALERT_THE_USER: &str = "The user may not be watching this conversation. If you have a notification tool for alerting them, call it now; do not message them through another service.";
pub const ANOTHER_INVOCATION: &str = "Another invocation is using the computer. Use computer_screen to discuss it, or computer_instruct to relay the user’s instructions.";
pub const COMPUTER_SCREEN_DESCRIPTION: &str = "Inspect your current desktop and browser. Inspect it again after navigation or user help. During human takeover, set userRequested only when the user explicitly asks you to inspect the screen. Automatic inspection waits for hand-back. While the user completes a help request, every inspection waits for hand-back.";
/// The literal parts of the `computer_help` description, around: `use && waitsForAnswer(use.mode) ? `This call waits up to ${WAIT_MINUTES} minutes for the user's answer, so do independent work first.` : 'Continue independent tasks; when only blocked work remains, end this turn and wait for the user.'`.
pub const COMPUTER_HELP_DESCRIPTION_PARTS: [&str; 1] = [
    "When computer work is blocked by a step only the user can complete, ask them for help, such as signing in, solving a CAPTCHA, or approving a device. Call it immediately; do not wait for the user to ask you to request help, and pass tab for the tab that needs help. Set credentials for any sign-in screen — one asking for a username and a password, for the username alone, or for the password alone — and the user is asked for their username and password where they are, and the runtime types both in, screen by screen. Never ask for either in chat, never offer to try one, and never report the sign-in and stop for instructions: make the call. A CAPTCHA, a device approval, or a second factor leaves credentials false. Preserves this help request and releases the computer for independent work. Explain what the user needs to do. ",
];
pub const COMPUTER_CONTINUE_DESCRIPTION: &str = "Resolve a computer help request after the user explicitly says they finished helping, or dismiss it at their request. Then inspect the screen before continuing. The commands you started are paused while the user takes over the computer to help, so also check whatever you left running. Use the help ID from computer_help.";
pub const COMPUTER_INSTRUCT_DESCRIPTION: &str = "Relay your user’s spoken instructions to the chat invocation currently using the computer. Use this instead of competing with it for input. The instructions appear in that conversation.";

/// The `computer` field's description, as `COMPUTER_FIELD` words it.
const COMPUTER_FIELD_DESCRIPTION: &str = "The computer to use, by its name in the computers notice. Leave it out for the default the notice names.";

/// `HELP_ANSWER_WAIT_MS` in minutes, as JavaScript writes the number.
fn wait_minutes() -> String {
    js::number_text(HELP_ANSWER_WAIT_MS as f64 / 60_000.0)
}

/// What a run that waited for its help request is told, by answer
/// (`continued`, `dismissed`, `unanswered`).
pub fn help_answer_text(answer: &str) -> String {
    match answer {
        "continued" => "The user finished helping. Inspect the screen, then continue the work. If something else blocks it, ask for that help now.".to_string(),
        "dismissed" => "The user dismissed the help request. Finish without the blocked work, and say in your reply what it left undone.".to_string(),
        _ => format!(
            "The user did not answer within {} minutes, and the request stays open. Finish without the blocked work, and say in your reply what is still blocked.",
            wait_minutes()
        ),
    }
}

/// The `computer_help` description. `waits` is whether the run waits for the
/// answer (`waits_for_answer(mode)` with an active invocation).
pub fn computer_help_description(waits: bool) -> String {
    let [head] = COMPUTER_HELP_DESCRIPTION_PARTS;
    if waits {
        format!(
            "{head}This call waits up to {} minutes for the user's answer, so do independent work first.",
            wait_minutes()
        )
    } else {
        format!(
            "{head}Continue independent tasks; when only blocked work remains, end this turn and wait for the user."
        )
    }
}

/// The voice channel of the call these tools serve, when there is one.
pub type VoiceChannel = Arc<dyn Fn() -> Option<Arc<dyn ModelChannel>> + Send + Sync>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerScreenInput {
    #[serde(default)]
    pub user_requested: bool,
    /// The computer to use, offered while remote computers exist.
    #[serde(default)]
    pub computer: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComputerHelpInput {
    pub reason: String,
    #[serde(default)]
    pub tab: Option<i64>,
    #[serde(default)]
    pub credentials: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputerContinueInput {
    pub help_id: String,
    #[serde(default)]
    pub dismiss: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ComputerInstructInput {
    pub instruction: String,
}

/// The `computer_screen` schema; `named` adds the `computer` field.
pub fn computer_screen_input_schema(named: bool) -> Value {
    let mut schema = json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "userRequested": {
                "default": false,
                "type": "boolean"
            }
        },
        "additionalProperties": false
    });
    if named {
        schema["properties"]["computer"] = json!({
            "description": COMPUTER_FIELD_DESCRIPTION,
            "type": "string"
        });
    }
    schema
}

pub fn computer_help_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "minLength": 1,
                "maxLength": 2000
            },
            "tab": {
                "type": "integer",
                "exclusiveMinimum": 0,
                "maximum": 9007199254740991_i64
            },
            "credentials": {
                "default": false,
                "type": "boolean"
            }
        },
        "required": ["reason"],
        "additionalProperties": false
    })
}

pub fn computer_continue_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "helpId": {
                "type": "string"
            },
            "dismiss": {
                "default": false,
                "type": "boolean"
            }
        },
        "required": ["helpId"],
        "additionalProperties": false
    })
}

pub fn computer_instruct_input_schema() -> Value {
    json!({
        "$schema": "http://json-schema.org/draft-07/schema#",
        "type": "object",
        "properties": {
            "instruction": {
                "type": "string",
                "minLength": 1,
                "maxLength": 4000
            }
        },
        "required": ["instruction"],
        "additionalProperties": false
    })
}

// ---------------------------------------------------------------------------
// Pictures beside a call's output

/// How long a call's pictures wait for the model output that shows them. The model
/// output of a step is built as soon as its calls end, so only a step that never got
/// there leaves pictures behind, and this bounds what they hold.
const PICTURES_KEPT: Duration = Duration::from_secs(60 * 60);

/// The pictures a call showed, by tool call id, until its model output takes them.
static PICTURES: LazyLock<Mutex<HashMap<String, (Instant, Vec<String>)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn keep_pictures(tool_call_id: &str, images: Vec<String>) {
    let mut pictures = PICTURES.lock();
    pictures.retain(|_, (at, _)| at.elapsed() < PICTURES_KEPT);
    pictures.insert(tool_call_id.to_string(), (Instant::now(), images));
}

fn take_pictures(tool_call_id: &str) -> Option<Vec<String>> {
    PICTURES
        .lock()
        .remove(tool_call_id)
        .map(|(_, images)| images)
}

/// The output as text, with the pictures its call showed after it: each one's data and
/// its media type, which a data URL names itself (`data:image/png;base64,…`).
fn picture_output(tool_call_id: &str, output: &Value) -> ToolResultOutput {
    let text = render_tool_result(output, &RenderToolResultOptions::default());
    let images = if output.is_object() {
        take_pictures(tool_call_id)
    } else {
        None
    };
    let Some(images) = images.filter(|images| !images.is_empty()) else {
        return ToolResultOutput::text(text);
    };
    let mut value = vec![ToolResultContentPart::Text {
        text,
        provider_options: None,
    }];
    for url in images {
        let media_type = match url.find(';') {
            Some(end) if end >= 5 => url[5..end].to_string(),
            Some(_) => String::new(),
            None => url
                .get(5..url.len().saturating_sub(1))
                .unwrap_or_default()
                .to_string(),
        };
        value.push(ToolResultContentPart::ImageData {
            data: url.split(',').nth(1).unwrap_or_default().to_string(),
            media_type,
            provider_options: None,
        });
    }
    ToolResultOutput::Content { value }
}

// ---------------------------------------------------------------------------
// Dispatch to the computer a call names

/// What one tool call carries beside the computer method's arguments: the `computer` it
/// named, which a tool need not pass on, and the pictures the computer showed.
struct CallScope {
    computer: Option<String>,
    images: Arc<Mutex<Vec<String>>>,
}

tokio::task_local! {
    static CALL: Arc<CallScope>;
}

fn computer_named(input: &Value) -> Option<String> {
    input
        .get("computer")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The computer a call names, or a refusal the model reads. The user's shared screen
/// arrives on the runtime's own Computer page, so that tool always asks the runtime's own.
fn session_for(
    computer_use: &ComputerUse,
    name: Option<&str>,
    property: &str,
) -> Result<Arc<ComputerSession>, String> {
    if property == "lookAtUserScreen" {
        return Ok(Arc::clone(&COMPUTER_SERVICE.local));
    }
    COMPUTER_SERVICE
        .resolve(computer_use, name)
        .map_err(|error| error.to_string())
}

/// Where a tool's pictures and narration go: the voice call's channel, else the call's
/// own pictures.
struct ToolChannel {
    voice: Option<VoiceChannel>,
    images: Arc<Mutex<Vec<String>>>,
    /// Whether narration reaches the voice call; `computer_screen` sends none.
    narrate: bool,
}

impl ModelChannel for ToolChannel {
    fn show_image(&self, image_url: &str, note: &str) -> bool {
        if let Some(voice) = &self.voice {
            return voice()
                .map(|channel| channel.show_image(image_url, note))
                .unwrap_or(false);
        }
        self.images.lock().push(image_url.to_string());
        true
    }

    fn notify(&self, text: &str) {
        if !self.narrate {
            return;
        }
        if let Some(channel) = self.voice.as_ref().and_then(|voice| voice()) {
            channel.notify(text);
        }
    }
}

/// What a computer method answers when the call is refused before it reaches a computer.
trait Refused {
    fn refused(message: String) -> Self;
}

impl Refused for DesktopActionResult {
    fn refused(message: String) -> Self {
        DesktopActionResult::new(false, message)
    }
}

impl Refused for ScreenLook {
    fn refused(message: String) -> Self {
        ScreenLook {
            success: false,
            message,
            ..Default::default()
        }
    }
}

impl Refused for FindTextResult {
    fn refused(message: String) -> Self {
        FindTextResult {
            success: false,
            message,
            matches: None,
        }
    }
}

impl Refused for UserScreenResult {
    fn refused(message: String) -> Self {
        UserScreenResult {
            success: false,
            message,
            text: None,
        }
    }
}

impl Refused for BrowserResult {
    fn refused(message: String) -> Self {
        BrowserResult::message(false, message)
    }
}

/// The computer the tools act on: each method goes to the computer its call names, as
/// the calling invocation, with that invocation's image sink.
struct Dispatch {
    computer_use: Option<Arc<ComputerUse>>,
    voice_channel: Option<VoiceChannel>,
}

impl Dispatch {
    async fn run<T, F, Fut>(&self, property: &str, action: F) -> anyhow::Result<T>
    where
        T: Refused + Send,
        F: FnOnce(Arc<dyn Computer>) -> Fut + Send,
        Fut: Future<Output = anyhow::Result<T>> + Send,
    {
        let Some(computer_use) = &self.computer_use else {
            anyhow::bail!("Computer tools require an active invocation.");
        };
        let (name, images) = CALL
            .try_with(|call| (call.computer.clone(), Arc::clone(&call.images)))
            .unwrap_or_default();
        let session = match session_for(computer_use, name.as_deref(), property) {
            Ok(session) => session,
            Err(message) => return Ok(T::refused(message)),
        };
        if computer_use.mode == "voice"
            && session
                .access
                .owner()
                .is_some_and(|owner| !Arc::ptr_eq(&owner, computer_use))
        {
            return Ok(T::refused(ANOTHER_INVOCATION.to_string()));
        }
        let channel = Arc::new(ToolChannel {
            voice: self.voice_channel.clone(),
            images,
            narrate: true,
        });
        COMPUTER_SERVICE
            .act(computer_use, &session, action, channel, false)
            .await
    }
}

#[async_trait]
impl ComputerBrowser for Dispatch {
    async fn browse(&self, command: BrowserCommand) -> anyhow::Result<BrowserResult> {
        self.run("browse", move |computer| async move {
            computer.browse(command).await
        })
        .await
    }

    async fn look_at_screen(&self) -> anyhow::Result<ScreenLook> {
        self.run("lookAtScreen", |computer| async move {
            computer.look_at_screen().await
        })
        .await
    }
}

#[async_trait]
impl ComputerDesktop for Dispatch {
    fn width(&self) -> i64 {
        picture_for(DEFAULT_SCREEN).width
    }

    fn height(&self) -> i64 {
        picture_for(DEFAULT_SCREEN).height
    }

    async fn list_elements(&self, input: ListElementsInput) -> anyhow::Result<DesktopActionResult> {
        self.run("listElements", move |computer| async move {
            computer.list_elements(input).await
        })
        .await
    }

    async fn list_windows(&self) -> anyhow::Result<DesktopActionResult> {
        self.run("listWindows", |computer| async move {
            computer.list_windows().await
        })
        .await
    }

    async fn window_action(&self, input: WindowActionInput) -> anyhow::Result<DesktopActionResult> {
        self.run("windowAction", move |computer| async move {
            computer.window_action(input).await
        })
        .await
    }

    async fn find_text(&self, input: FindTextInput) -> anyhow::Result<FindTextResult> {
        self.run("findText", move |computer| async move {
            computer.find_text(input).await
        })
        .await
    }

    async fn click_text(&self, input: ClickTextInput) -> anyhow::Result<DesktopActionResult> {
        self.run("clickText", move |computer| async move {
            computer.click_text(input).await
        })
        .await
    }

    async fn move_pointer(&self, input: MoveInput) -> anyhow::Result<DesktopActionResult> {
        self.run("move", move |computer| async move {
            computer.move_pointer(input).await
        })
        .await
    }

    async fn click(&self, input: ClickInput) -> anyhow::Result<DesktopActionResult> {
        self.run("click", move |computer| async move {
            computer.click(input).await
        })
        .await
    }

    async fn drag(&self, input: DragInput) -> anyhow::Result<DesktopActionResult> {
        self.run(
            "drag",
            move |computer| async move { computer.drag(input).await },
        )
        .await
    }

    async fn type_text(&self, input: TypeInput) -> anyhow::Result<DesktopActionResult> {
        self.run("type", move |computer| async move {
            computer.type_text(input).await
        })
        .await
    }

    async fn key(&self, input: KeyInput) -> anyhow::Result<DesktopActionResult> {
        self.run(
            "key",
            move |computer| async move { computer.key(input).await },
        )
        .await
    }

    async fn scroll(&self, input: ScrollInput) -> anyhow::Result<DesktopActionResult> {
        self.run("scroll", move |computer| async move {
            computer.scroll(input).await
        })
        .await
    }
}

#[async_trait]
impl ComputerUserScreen for Dispatch {
    async fn look_at_user_screen(&self) -> anyhow::Result<UserScreenResult> {
        self.run("lookAtUserScreen", |computer| async move {
            computer.look_at_user_screen().await
        })
        .await
    }
}

/// `execute` run with the call's `computer` and picture sink in scope, and the pictures
/// the computer showed kept for the call's model output.
fn dispatched(execute: ToolExecuteFunction) -> ToolExecuteFunction {
    execute_fn(move |input: Value, options| {
        let execute = Arc::clone(&execute);
        async move {
            let call = Arc::new(CallScope {
                computer: computer_named(&input),
                images: Arc::new(Mutex::new(Vec::new())),
            });
            let tool_call_id = options.tool_call_id.clone();
            let output = CALL
                .scope(Arc::clone(&call), execute(input, options))
                .await?;
            let images = std::mem::take(&mut *call.images.lock());
            if !images.is_empty() && output.is_object() {
                keep_pictures(&tool_call_id, images);
            }
            Ok(output)
        }
    })
}

/// Wait for the answer to a help request, through the invocation's idle wrapper when it
/// has one.
async fn answered(
    computer_use: &ComputerUse,
    answer: oneshot::Receiver<anyhow::Result<HelpAnswer>>,
) -> anyhow::Result<HelpAnswer> {
    let slot: Arc<Mutex<Option<anyhow::Result<HelpAnswer>>>> = Arc::new(Mutex::new(None));
    let filled = Arc::clone(&slot);
    let wait: BoxFuture<'static, ()> = Box::pin(async move {
        let result = answer.await.map_err(anyhow::Error::from).and_then(|r| r);
        *filled.lock() = Some(result);
    });
    let idle = computer_use.idle.lock().clone();
    match idle {
        Some(idle) => idle(wait).await,
        None => wait.await,
    }
    let result = slot.lock().take();
    result.unwrap_or_else(|| Err(anyhow::anyhow!("The help request has no answer.")))
}

fn outcome(success: bool, message: &str) -> Value {
    json!({ "success": success, "message": message })
}

/// Schemas stay fixed for a mode and for the set of computers; the calling
/// invocation supplies its ownership and image sink. A run that may use a remote
/// computer names it in each call's `computer` once one exists. `mode` is the
/// invocation's (`computer_use.mode` when `None`), and a request that has none,
/// such as a compaction, passes the mode whose tools block it repeats.
///
/// Each base tool runs on the computer its call names, with the images it shows
/// returned beside its text in the model output (`render_tool_result` of the
/// output, then each image's data and media type from its data URL). A voice
/// call that finds the computer in another invocation's hands is told
/// `ANOTHER_INVOCATION`. `computer_browse` is left out for a run that names
/// remote computers on a runtime with no computer of its own.
pub fn get_computer_tools(
    computer_use: Option<Arc<ComputerUse>>,
    voice_channel: Option<VoiceChannel>,
    mode: Option<&str>,
) -> ToolSet {
    let mode = mode
        .map(str::to_string)
        .or_else(|| computer_use.as_ref().map(|used| used.mode.clone()));
    let named =
        mode.as_deref().is_some_and(uses_remote_computers) && REMOTE_COMPUTER_SERVICE.count() > 0;
    let desktop = Arc::new(Dispatch {
        computer_use: computer_use.clone(),
        voice_channel: voice_channel.clone(),
    });
    let base = create_computer_tools(
        desktop.clone(),
        Some(desktop.clone() as Arc<dyn ComputerDesktop>),
        voice_channel
            .is_some()
            .then(|| desktop.clone() as Arc<dyn ComputerUserScreen>),
        named,
    );
    let shown = to_model_output_fn(|options: crate::ai::ToModelOutputOptions| async move {
        Ok(picture_output(&options.tool_call_id, &options.output))
    });
    let mut result = ToolSet::new();
    for (name, original) in base {
        // The browser tool is the runtime's own browser. A run on a runtime that has only
        // remote computers uses a computer's browser through its desktop.
        if name == "computer_browse" && named && !has_computer() {
            continue;
        }
        let execute = original.execute.clone().map(dispatched);
        result.insert(
            name,
            Tool {
                execute,
                to_model_output: Some(shown.clone()),
                ..original
            },
        );
    }

    let (used, voice) = (computer_use.clone(), voice_channel.clone());
    result.insert(
        "computer_screen".to_string(),
        tool(Tool {
            description: Some(COMPUTER_SCREEN_DESCRIPTION.to_string()),
            input_schema: zod_schema(computer_screen_input_schema(named)),
            execute: Some(execute_fn(move |input: Value, options| {
                let (used, voice) = (used.clone(), voice.clone());
                async move {
                    let Some(computer_use) = used else {
                        anyhow::bail!("Screen inspection requires an active invocation.");
                    };
                    let input: ComputerScreenInput = serde_json::from_value(input)?;
                    let session =
                        match session_for(&computer_use, input.computer.as_deref(), "lookAtScreen")
                        {
                            Ok(session) => session,
                            Err(message) => return Ok(outcome(false, &message)),
                        };
                    let images = Arc::new(Mutex::new(Vec::new()));
                    let channel = Arc::new(ToolChannel {
                        voice,
                        images: Arc::clone(&images),
                        narrate: false,
                    });
                    // An inspection is the one look that outruns the desktop's queue, so a
                    // secure takeover withdraws it: the user's own screen is theirs alone
                    // until they hand back.
                    let inspection = !session.access.secure()
                        && (input.user_requested
                            || (computer_use.mode == "voice" && !session.access.paused()));
                    let output = COMPUTER_SERVICE
                        .act(
                            &computer_use,
                            &session,
                            |computer| async move { computer.look_at_screen().await },
                            channel,
                            inspection,
                        )
                        .await?;
                    let images = std::mem::take(&mut *images.lock());
                    if !images.is_empty() {
                        keep_pictures(&options.tool_call_id, images);
                    }
                    Ok(serde_json::to_value(output)?)
                }
            })),
            to_model_output: Some(shown),
            ..Default::default()
        }),
    );

    let used = computer_use.clone();
    let waits = computer_use
        .as_ref()
        .is_some_and(|used| waits_for_answer(&used.mode));
    result.insert(
        "computer_help".to_string(),
        tool(Tool {
            description: Some(computer_help_description(waits)),
            input_schema: zod_schema(computer_help_input_schema()),
            execute: Some(execute_fn(move |input: Value, _| {
                let used = used.clone();
                async move {
                    let Some(computer_use) = used else {
                        anyhow::bail!("Computer help requires an active invocation.");
                    };
                    let input: ComputerHelpInput = serde_json::from_value(input)?;
                    let request = COMPUTER_SERVICE
                        .current(&computer_use)
                        .access
                        .run(
                            &computer_use,
                            || {
                                COMPUTER_HELP_SERVICE.request(
                                    &computer_use,
                                    &input.reason,
                                    input.tab,
                                    input.credentials,
                                )
                            },
                            false,
                        )
                        .await?;
                    let (help, repeated) = (request.help, request.repeated);
                    if let Some(answer) = request.answer {
                        let answer = answered(&computer_use, answer).await?;
                        let already = if repeated {
                            format!(
                                "A help request was already waiting for the user, so nothing new was sent. It asks: {}. ",
                                serde_json::to_string(&help.reason)?
                            )
                        } else {
                            String::new()
                        };
                        return Ok(json!({
                            "success": true,
                            "helpId": help.id,
                            "answer": answer.as_str(),
                            "message": format!("{already}{}", help_answer_text(answer.as_str())),
                        }));
                    }
                    // Asked for credentials and offered the desktop: the tab held no sign-in form.
                    let desktop = !repeated && input.credentials && help.credentials != Some(true);
                    let message = if repeated {
                        format!(
                            "A help request is already waiting for the user, so nothing new was sent. It asks: {}. If something else blocks this run, say what in your reply. Continue independent work or finish this turn while waiting for the user.",
                            serde_json::to_string(&help.reason)?
                        )
                    } else if desktop {
                        format!(
                            "No sign-in form was found, so the user is asked to take over the desktop instead. {ALERT_THE_USER} Continue independent work or finish this turn while waiting for the user."
                        )
                    } else {
                        format!(
                            "Help requested. {ALERT_THE_USER} Continue independent work or finish this turn while waiting for the user."
                        )
                    };
                    Ok(json!({
                        "success": true,
                        "helpId": help.id,
                        "url": computer_link(Some(&help.id), help.computer_id.as_deref()),
                        "credentials": help.credentials.unwrap_or(false),
                        "message": message,
                    }))
                }
            })),
            ..Default::default()
        }),
    );

    let used = computer_use.clone();
    result.insert(
        "computer_continue".to_string(),
        tool(Tool {
            description: Some(COMPUTER_CONTINUE_DESCRIPTION.to_string()),
            input_schema: zod_schema(computer_continue_input_schema()),
            execute: Some(execute_fn(move |input: Value, _| {
                let used = used.clone();
                async move {
                    let Some(computer_use) = used else {
                        anyhow::bail!("Computer help requires an active invocation.");
                    };
                    let input: ComputerContinueInput = serde_json::from_value(input)?;
                    let (agent_id, user_id) = (&computer_use.agent_id, &computer_use.user_id);
                    // Refused before the request is resolved, so a request is never closed on a
                    // computer that is still in the hands of the person at it.
                    let asked = COMPUTER_HELP_SERVICE
                        .list(agent_id, user_id, None)
                        .await?
                        .into_iter()
                        .find(|help| help.id == input.help_id);
                    let asked_computer = asked.as_ref().and_then(|help| help.computer_id.as_deref());
                    if !input.dismiss
                        && COMPUTER_HELP_SERVICE.session_of(asked_computer).controller()
                            == Some(Controller::Local)
                    {
                        return Ok(outcome(false, HELD_LOCALLY));
                    }
                    let status = if input.dismiss {
                        HelpStatus::Dismissed
                    } else {
                        HelpStatus::Continued
                    };
                    let Some(resolved) = COMPUTER_HELP_SERVICE
                        .resolve(agent_id, user_id, &input.help_id, status)
                        .await?
                    else {
                        return Ok(outcome(false, "This help request is already closed."));
                    };
                    let session =
                        COMPUTER_HELP_SERVICE.session_of(resolved.help.computer_id.as_deref());
                    if !input.dismiss && session.access.paused() {
                        session.continue_from_chat().await?;
                    }
                    if resolved.answered_runs > 0 && resolved.help.requester_waits == Some(true) {
                        return Ok(outcome(
                            true,
                            "The run that asked for this help has the answer and continues by itself. Leave its work to it.",
                        ));
                    }
                    let goal_resumed = if input.dismiss {
                        false
                    } else {
                        COMPUTER_HELP_SERVICE
                            .resume_goal(agent_id, user_id, &resolved.help)
                            .await?
                    };
                    Ok(outcome(
                        true,
                        if goal_resumed {
                            "The goal has resumed and will continue the original work."
                        } else {
                            "Help resolved. Inspect the screen before continuing."
                        },
                    ))
                }
            })),
            ..Default::default()
        }),
    );

    if voice_channel.is_some() {
        result.insert(
            "computer_instruct".to_string(),
            tool(Tool {
                description: Some(COMPUTER_INSTRUCT_DESCRIPTION.to_string()),
                input_schema: zod_schema(computer_instruct_input_schema()),
                execute: Some(execute_fn(|input: Value, _| async move {
                    let input: ComputerInstructInput = serde_json::from_value(input)?;
                    // A voice call is held on the runtime's own computer, so that is the one it
                    // relays to.
                    let owner = COMPUTER_SERVICE.local.access.owner();
                    let Some((owner, thread_id)) = owner.and_then(|owner| {
                        let thread_id = owner.thread_id.clone()?;
                        (owner.mode == "chat").then_some((owner, thread_id))
                    }) else {
                        return Ok(outcome(
                            false,
                            "No active chat invocation is using the computer. Use the computer tools when it is available.",
                        ));
                    };
                    let context = MESSAGE_DELIVERY_SERVICE
                        .thread_context(
                            &thread_id,
                            owner.origin_channel.as_ref().map(|channel| channel.as_str()),
                            owner.origin_channel_id.as_deref(),
                        )
                        .await?;
                    let response = CONVERSATION_ENGINE_SERVICE
                        .chat(ChatInput {
                            agent_id: owner.agent_id.clone(),
                            user_id: owner.user_id.clone(),
                            thread_id: Some(thread_id),
                            message: input.instruction,
                            steer_only: Some(true),
                            metadata: Some(ChatMetadata {
                                channel: Some(context.context.channel),
                                channel_id: context.context.channel_id,
                                channel_thread_id: context.context.channel_thread_id,
                                channel_label: context.channel_label,
                                ..Default::default()
                            }),
                            ..Default::default()
                        })
                        .await?;
                    let steered = response.steered == Some(true);
                    Ok(outcome(
                        steered,
                        if steered {
                            "Instructions sent to the active conversation."
                        } else {
                            "That invocation has finished. You can use the computer now."
                        },
                    ))
                })),
                ..Default::default()
            }),
        );
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[serial_test::serial]
    async fn the_definitions_match_the_typescript_runtime() {
        // The fixture holds the tools with no remote computer registered; the computers
        // other tests add stay in the service's memory, so it is reloaded empty.
        let _db = crate::db::testing::test_db();
        REMOTE_COMPUTER_SERVICE
            .load("agent-without-computers")
            .await
            .unwrap();
        let tools = get_computer_tools(None, None, Some("chat"));
        crate::tools::schema_fixture::assert_matches_fixture("computer:chat", &tools);
    }

    #[test]
    fn uses_canonical_computer_names_in_declarations_and_descriptions() {
        let tools = get_computer_tools(None, None, None);
        for (name, item) in &tools {
            assert!(name.starts_with("computer_"), "{name}");
            let description = item.description.clone().unwrap_or_default();
            for old in ["desktop_", "see_screen", "see_user_screen", "`browse`"] {
                assert!(!description.contains(old), "{name}: {old}");
            }
        }
        assert!(tools.contains_key("computer_browse"));
        assert!(tools.contains_key("computer_click"));
    }

    #[test]
    fn describes_model_picture_coordinates_independently_of_desktop_resolution() {
        let tools = get_computer_tools(None, None, None);
        let description = tools["computer_click"].description.clone().unwrap();
        assert!(description.contains("1280 by 720"), "{description}");
    }

    #[test]
    fn offers_the_user_screen_only_to_a_voice_session_that_supports_screen_sharing() {
        assert!(!get_computer_tools(None, None, None).contains_key("computer_user_screen"));
        let voice: VoiceChannel = Arc::new(|| None);
        let tools = get_computer_tools(None, Some(voice), None);
        assert!(tools.contains_key("computer_user_screen"));
        assert!(tools.contains_key("computer_instruct"));
    }

    #[test]
    fn adds_the_computer_field_to_the_screen_schema_when_computers_are_named() {
        let schema = computer_screen_input_schema(true);
        assert_eq!(
            serde_json::to_string(&schema["properties"]).unwrap(),
            format!(
                r#"{{"userRequested":{{"default":false,"type":"boolean"}},"computer":{{"description":"{COMPUTER_FIELD_DESCRIPTION}","type":"string"}}}}"#
            )
        );
    }

    #[test]
    fn words_the_help_description_for_a_run_that_waits() {
        assert!(computer_help_description(true).ends_with(
            "This call waits up to 30 minutes for the user's answer, so do independent work first."
        ));
        assert!(
            help_answer_text("unanswered").starts_with("The user did not answer within 30 minutes")
        );
    }

    #[test]
    fn shows_the_pictures_a_call_showed_beside_its_text() {
        keep_pictures("call-1", vec!["data:image/png;base64,AAAA".to_string()]);
        let output = json!({ "success": true, "message": "Clicked." });
        let shown = serde_json::to_value(picture_output("call-1", &output)).unwrap();
        assert_eq!(
            shown,
            json!({
                "type": "content",
                "value": [
                    { "type": "text", "text": "{\"success\":true,\"message\":\"Clicked.\"}" },
                    { "type": "image-data", "data": "AAAA", "mediaType": "image/png" },
                ],
            })
        );
        // The pictures go with the first model output that shows them.
        let again = serde_json::to_value(picture_output("call-1", &output)).unwrap();
        assert_eq!(again["type"], json!("text"));
    }
}
