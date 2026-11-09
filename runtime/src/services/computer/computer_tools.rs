//! Browser, desktop, and shared-screen tools for the agent's computer.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::ai::tool::{execute_fn, tool, zod_schema};
use crate::ai::{Tool, ToolSet};
use crate::services::meeting::browser_control::{BrowserCommand, BrowserResult};

pub use super::desktop_control::{MouseButton, ScrollDirection};
pub use super::desktop_windows::WindowAction;

/// What `computer_screen` answers: whether the model got a picture and what it shows, with
/// the reading of the browser tab in front where there is one.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ScreenLook {
    pub success: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    /// The page's rendered text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    /// Names of links, buttons and fields, in page order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub controls: Option<Vec<String>>,
}

/// What a session offers the tools: its browser, and the model to show a picture to.
///
/// A computer answers every outcome of its own in the result. An error is a call that
/// never reached a computer, which the model reads as the tool's error.
#[async_trait]
pub trait ComputerBrowser: Send + Sync {
    async fn browse(&self, command: BrowserCommand) -> anyhow::Result<BrowserResult>;
    async fn look_at_screen(&self) -> anyhow::Result<ScreenLook>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DesktopActionResult {
    pub success: bool,
    pub message: String,
}

impl DesktopActionResult {
    pub fn new(success: bool, message: impl Into<String>) -> Self {
        DesktopActionResult {
            success,
            message: message.into(),
        }
    }
}

/// Where a control or some words were found on the screen, in picture coordinates.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextLocation {
    pub text: String,
    /// For a control, its role and program; for words, the line they sit in.
    pub line: String,
    pub x: i64,
    pub y: i64,
}

/// What `computer_find_text` answers.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindTextResult {
    pub success: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub matches: Option<Vec<TextLocation>>,
}

/// What `computer_user_screen` answers: the picture's outcome, plus the words on it as
/// `text` where the host can read them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct UserScreenResult {
    pub success: bool,
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

/// What the user is sharing from their own screen, when they are.
#[async_trait]
pub trait ComputerUserScreen: Send + Sync {
    /// The picture into the session, plus the words on it as `text` where the host can
    /// read them.
    async fn look_at_user_screen(&self) -> anyhow::Result<UserScreenResult>;
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ListElementsInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WindowActionInput {
    pub title: String,
    pub action: WindowAction,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FindTextInput {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ClickTextInput {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub occurrence: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub double: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct MoveInput {
    pub x: f64,
    pub y: f64,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize, Deserialize)]
pub struct ClickInput {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub x: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub y: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub double: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DragInput {
    pub from_x: f64,
    pub from_y: f64,
    pub to_x: f64,
    pub to_y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub button: Option<MouseButton>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypeInput {
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct KeyInput {
    pub keys: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ScrollInput {
    pub x: f64,
    pub y: f64,
    pub direction: ScrollDirection,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clicks: Option<i64>,
}

/// The desktop a session owns, when it owns one. Every action shows the model the result.
/// `width` and `height` are the model's picture, which its coordinates refer to.
#[async_trait]
pub trait ComputerDesktop: Send + Sync {
    fn width(&self) -> i64;
    fn height(&self) -> i64;
    async fn list_elements(&self, input: ListElementsInput) -> anyhow::Result<DesktopActionResult>;
    async fn list_windows(&self) -> anyhow::Result<DesktopActionResult>;
    async fn window_action(&self, input: WindowActionInput) -> anyhow::Result<DesktopActionResult>;
    async fn find_text(&self, input: FindTextInput) -> anyhow::Result<FindTextResult>;
    async fn click_text(&self, input: ClickTextInput) -> anyhow::Result<DesktopActionResult>;
    async fn move_pointer(&self, input: MoveInput) -> anyhow::Result<DesktopActionResult>;
    async fn click(&self, input: ClickInput) -> anyhow::Result<DesktopActionResult>;
    async fn drag(&self, input: DragInput) -> anyhow::Result<DesktopActionResult>;
    async fn type_text(&self, input: TypeInput) -> anyhow::Result<DesktopActionResult>;
    async fn key(&self, input: KeyInput) -> anyhow::Result<DesktopActionResult>;
    async fn scroll(&self, input: ScrollInput) -> anyhow::Result<DesktopActionResult>;
}

/// The field that picks a computer, on every tool that acts on one once remote computers
/// exist: the `properties` entry of an optional string, never listed in `required`.
pub static COMPUTER_FIELD: LazyLock<Value> = LazyLock::new(|| {
    json!({
        "computer": {
            "description": "The computer to use, by its name in the computers notice. Leave it out for the default the notice names.",
            "type": "string"
        }
    })
});

const SCHEMA_DRAFT: &str = "http://json-schema.org/draft-07/schema#";

/// `z.object(...)` as the provider receives it: the properties, and the names it requires
/// when there are any.
fn object_schema(properties: Value, required: &[&str]) -> Value {
    let mut schema = serde_json::Map::new();
    schema.insert("$schema".into(), json!(SCHEMA_DRAFT));
    schema.insert("type".into(), json!("object"));
    schema.insert("properties".into(), properties);
    if !required.is_empty() {
        schema.insert("required".into(), json!(required));
    }
    schema.insert("additionalProperties".into(), json!(false));
    Value::Object(schema)
}

/// `.extend(COMPUTER_FIELD)`: the schema with `computer` after its own properties.
fn with_computer_field(schema: &Value) -> Value {
    let mut schema = schema.clone();
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        if let Some(field) = COMPUTER_FIELD.as_object() {
            for (key, value) in field {
                properties.insert(key.clone(), value.clone());
            }
        }
    }
    schema
}

/// A tool whose input parses into `I` and whose answer is `O`, both as the model sees them.
fn computer_tool<I, O, F, Fut>(description: String, schema: Value, run: F) -> Tool
where
    I: DeserializeOwned + Send + 'static,
    O: Serialize,
    F: Fn(I) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = anyhow::Result<O>> + Send + 'static,
{
    let run = Arc::new(run);
    tool(Tool {
        description: Some(description),
        input_schema: zod_schema(schema),
        execute: Some(execute_fn(move |input: Value, _options| {
            let run = run.clone();
            async move {
                let input: I = serde_json::from_value(input)?;
                let output = run(input).await?;
                Ok(serde_json::to_value(output)?)
            }
        })),
        ..Tool::default()
    })
}

/// The tools, with `computer` on each one that acts on a computer when `named`. The user's
/// shared screen is not on any computer, so its tool takes none.
///
/// The order is the one the tools block sends: `computer_user_screen` (with a user screen),
/// the desktop tools (with a desktop: `computer_elements`, `computer_windows`,
/// `computer_window`, `computer_click_text`, `computer_find_text`, `computer_move`,
/// `computer_click`, `computer_drag`, `computer_type`, `computer_key`, `computer_scroll`),
/// then `computer_browse` and `computer_screen`.
pub fn create_computer_tools(
    browser: Arc<dyn ComputerBrowser>,
    desktop: Option<Arc<dyn ComputerDesktop>>,
    user_screen: Option<Arc<dyn ComputerUserScreen>>,
    named: bool,
) -> ToolSet {
    let tools = computer_tools(browser, desktop, user_screen, named);
    if !named {
        return tools;
    }
    tools
        .into_iter()
        .map(|(name, item)| {
            if name == "computer_user_screen" {
                return (name, item);
            }
            let schema = with_computer_field(item.input_schema.json_schema());
            (
                name,
                Tool {
                    input_schema: zod_schema(schema),
                    ..item
                },
            )
        })
        .collect()
}

/// The tools before `computer` is added to them.
fn computer_tools(
    browser: Arc<dyn ComputerBrowser>,
    desktop: Option<Arc<dyn ComputerDesktop>>,
    user_screen: Option<Arc<dyn ComputerUserScreen>>,
    named: bool,
) -> ToolSet {
    let screen_description = match &desktop {
        Some(desktop) => format!(
            "See your whole screen right now — a {} by {} picture of the desktop with every window on it, plus the text and controls of the browser tab in front. Use it to find what to click, to check what an action did, or to answer a question about what is on screen. Takes a couple of seconds.",
            desktop.width(),
            desktop.height()
        ),
        None => "See what your browser is showing right now — a picture of the tab in front, plus the text and controls of the page. Use it to check a page `computer_browse` reported oddly, or to answer a question about what is on screen. Takes a couple of seconds.".to_string(),
    };

    let mut tools = ToolSet::new();
    if let Some(user_screen) = user_screen {
        tools.insert(
            "computer_user_screen".to_string(),
            computer_tool(
                "Look at what your user is sharing from their own screen — a window, a tab or their whole screen, as it looks right now. You get the picture and, read off it, the exact words on it, so trust the text for an error message, a name or a number and the picture for where things are. Use it when they point at something on their side: \"look at this\", \"this error\", \"my dashboard\". Says so if they are not sharing.".to_string(),
                object_schema(json!({}), &[]),
                move |_: EmptyInput| {
                    let user_screen = user_screen.clone();
                    async move { user_screen.look_at_user_screen().await }
                },
            ),
        );
    }

    if let Some(desktop) = desktop {
        tools.extend(create_desktop_tools(desktop, named));
    }

    let browse = browser.clone();
    tools.insert(
        "computer_browse".to_string(),
        computer_tool(
            "Use your web browser: open a page, click things, type, scroll, and work in several tabs. Every command answers with where the page is, what it says, the names of the links, buttons and fields on it, and the list of open tabs. Click and type by those names, and switch tabs by those numbers. Use it for labeled page controls in a web page. To only read a page, use web_fetch, which is faster. One command per call.".to_string(),
            object_schema(
                json!({
                    "action": {
                        "type": "string",
                        "enum": ["navigate", "click", "type", "press", "scroll", "read", "new_tab", "switch_tab", "close_tab"],
                        "description": "\"navigate\" opens a URL in the tab you are in, \"click\" presses something, \"type\" enters text, \"press\" sends one key (Enter, Escape, PageDown), \"scroll\" moves the page, \"read\" just reports where you are. \"new_tab\" opens another tab (pass a url to land on a page), \"switch_tab\" moves to a tab by number, \"close_tab\" closes one."
                    },
                    "url": {
                        "description": "For \"navigate\", and for a \"new_tab\" that should open a page.",
                        "type": "string"
                    },
                    "tab": {
                        "description": "For \"switch_tab\" and \"close_tab\": the tab number from the last answer. \"close_tab\" without one closes the tab you are in.",
                        "type": "number"
                    },
                    "target": {
                        "description": "For \"click\", and optionally for \"type\": the words on the link, button or field, as they came back in the last reading. A CSS selector also works.",
                        "type": "string"
                    },
                    "text": { "description": "For \"type\": what to enter.", "type": "string" },
                    "key": { "description": "For \"press\": the key name, e.g. Enter.", "type": "string" },
                    "amount": {
                        "description": "For \"scroll\": pixels to scroll, negative to go up. Defaults to 600.",
                        "type": "number"
                    }
                }),
                &["action"],
            ),
            move |command: BrowserCommand| {
                let browser = browse.clone();
                async move { browser.browse(command).await }
            },
        ),
    );

    tools.insert(
        "computer_screen".to_string(),
        computer_tool(
            screen_description,
            object_schema(json!({}), &[]),
            move |_: EmptyInput| {
                let browser = browser.clone();
                async move { browser.look_at_screen().await }
            },
        ),
    );
    tools
}

/// The input of a tool that takes none.
#[derive(Debug, Clone, Default, Deserialize)]
struct EmptyInput {}

/// One desktop tool that calls `act` on the desktop with its parsed input.
fn desktop_tool<I, O, F, Fut>(
    desktop: &Arc<dyn ComputerDesktop>,
    description: String,
    schema: Value,
    act: F,
) -> Tool
where
    I: DeserializeOwned + Send + 'static,
    O: Serialize,
    F: Fn(Arc<dyn ComputerDesktop>, I) -> Fut + Send + Sync + 'static,
    Fut: std::future::Future<Output = anyhow::Result<O>> + Send + 'static,
{
    let desktop = desktop.clone();
    computer_tool(description, schema, move |input: I| {
        act(desktop.clone(), input)
    })
}

/// The desktop tools. Each computer's picture has its own size, which every picture's
/// answer states, so with `named` the coordinate text names no size.
fn create_desktop_tools(desktop: Arc<dyn ComputerDesktop>, named: bool) -> ToolSet {
    // Each computer's picture has its own size, which every picture's answer states.
    let picture = if named {
        "the latest picture of that computer's screen, from `computer_screen` or the last action"
            .to_string()
    } else {
        format!(
            "the {} by {} picture from `computer_screen`",
            desktop.width(),
            desktop.height()
        )
    };
    let place = format!(
        "Pixel coordinates in {picture}: x from the left edge, y from the top. Aim at the middle of the button or row."
    );
    let button = json!({
        "description": "Defaults to left.",
        "type": "string",
        "enum": ["left", "middle", "right"]
    });
    let double = json!({ "description": "True for a double-click.", "type": "boolean" });

    let mut tools = ToolSet::new();
    tools.insert(
        "computer_elements".to_string(),
        desktop_tool(
            &desktop,
            "Read the desktop the way `computer_browse` reads a page: every visible control by name and position — menu items, buttons, tabs, fields, windows — grouped by program. Use the names with `computer_click_text`. Pass `filter` to list only names containing some words. A program that does not describe itself shows nothing here; use `computer_screen` for those.".to_string(),
            object_schema(
                json!({
                    "filter": { "description": "Only controls whose name contains this.", "type": "string" }
                }),
                &[],
            ),
            |desktop, input: ListElementsInput| async move { desktop.list_elements(input).await },
        ),
    );
    tools.insert(
        "computer_windows".to_string(),
        desktop_tool(
            &desktop,
            "List the open windows on your desktop by title, with their position and size."
                .to_string(),
            object_schema(json!({}), &[]),
            |desktop, _: EmptyInput| async move { desktop.list_windows().await },
        ),
    );
    tools.insert(
        "computer_window".to_string(),
        desktop_tool(
            &desktop,
            "Manage a window by its title: bring it to the front, close it, maximise it, restore it, or minimise it. Use this instead of aiming at the small buttons in a title bar. Answers with a fresh picture.".to_string(),
            object_schema(
                json!({
                    "title": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The window title, or a distinctive part of it."
                    },
                    "action": {
                        "type": "string",
                        "enum": ["focus", "close", "maximize", "restore", "minimize"]
                    }
                }),
                &["title", "action"],
            ),
            |desktop, input: WindowActionInput| async move { desktop.window_action(input).await },
        ),
    );
    tools.insert(
        "computer_click_text".to_string(),
        desktop_tool(
            &desktop,
            "Click a control or some words by name — a menu row, a button, a tab, a link, a file name. Give the name as it appears; the desktop's own controls are looked up first and clicked at their exact centre, and words with no control behind them are read off the screen. Prefer this over `computer_click` with coordinates whenever the target has a name, since it does not miss. If the name appears more than once, `occurrence` picks which, counted from the top. Answers with a fresh picture after the click, or says the name is not on screen.".to_string(),
            object_schema(
                json!({
                    "text": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The words on the target, as they appear on screen."
                    },
                    "occurrence": {
                        "description": "Which match to click when there are several, 1 being the topmost. Defaults to 1.",
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 9007199254740991_i64
                    },
                    "button": button.clone(),
                    "double": double.clone()
                }),
                &["text"],
            ),
            |desktop, input: ClickTextInput| async move { desktop.click_text(input).await },
        ),
    );
    tools.insert(
        "computer_find_text".to_string(),
        desktop_tool(
            &desktop,
            "Find a control or some words on your desktop by name and get their exact coordinates, without clicking. Use it to check whether something is on screen, to tell apart several places the same name appears, or to get a precise point for `computer_move`, `computer_drag` or `computer_scroll`.".to_string(),
            object_schema(
                json!({
                    "text": {
                        "type": "string",
                        "minLength": 1,
                        "description": "The words to look for, as they appear on screen."
                    }
                }),
                &["text"],
            ),
            |desktop, input: FindTextInput| async move { desktop.find_text(input).await },
        ),
    );
    tools.insert(
        "computer_move".to_string(),
        desktop_tool(
            &desktop,
            format!(
                "Put the pointer somewhere on your desktop without clicking, and see it there. Use it before clicking a small target such as a menu row: the picture that comes back shows the pointer, so you can check it sits on the target and then call `computer_click` with no coordinates to click right there. {place}"
            ),
            object_schema(
                json!({
                    "x": { "type": "number", "description": "Pixels from the left edge." },
                    "y": { "type": "number", "description": "Pixels from the top edge." }
                }),
                &["x", "y"],
            ),
            |desktop, input: MoveInput| async move { desktop.move_pointer(input).await },
        ),
    );
    tools.insert(
        "computer_click".to_string(),
        desktop_tool(
            &desktop,
            format!(
                "Click on your desktop: a menu, a button, a window, a text field to focus. With coordinates it clicks there; without, it clicks where the pointer already is, which is how to commit a spot you checked with `computer_move`. {place} Answers with a fresh picture of the screen after the click; the pointer in it shows where the click landed."
            ),
            object_schema(
                json!({
                    "x": {
                        "description": "Pixels from the left edge. Omit to click where the pointer is.",
                        "type": "number"
                    },
                    "y": {
                        "description": "Pixels from the top edge. Omit to click where the pointer is.",
                        "type": "number"
                    },
                    "button": button.clone(),
                    "double": double
                }),
                &[],
            ),
            |desktop, input: ClickInput| async move { desktop.click(input).await },
        ),
    );
    tools.insert(
        "computer_drag".to_string(),
        desktop_tool(
            &desktop,
            format!(
                "Drag on your desktop: press at one point, move to another, release. This is how to move a window or a slider, or to select text. It walks the path in steps so the program sees the motion. {place} Answers with a fresh picture after the release."
            ),
            object_schema(
                json!({
                    "fromX": { "type": "number", "description": "Where to press: pixels from the left edge." },
                    "fromY": { "type": "number", "description": "Where to press: pixels from the top edge." },
                    "toX": { "type": "number", "description": "Where to release: pixels from the left edge." },
                    "toY": { "type": "number", "description": "Where to release: pixels from the top edge." },
                    "button": button
                }),
                &["fromX", "fromY", "toX", "toY"],
            ),
            |desktop, input: DragInput| async move { desktop.drag(input).await },
        ),
    );
    tools.insert(
        "computer_type".to_string(),
        desktop_tool(
            &desktop,
            "Type text on your desktop, into whatever has the keyboard focus — click a field or a terminal first. Answers with a fresh picture of the screen.".to_string(),
            object_schema(
                json!({
                    "text": { "type": "string", "minLength": 1, "description": "The text to type, as is." }
                }),
                &["text"],
            ),
            |desktop, input: TypeInput| async move { desktop.type_text(input).await },
        ),
    );
    tools.insert(
        "computer_key".to_string(),
        desktop_tool(
            &desktop,
            "Press one key or a chord on your desktop, such as \"Return\", \"Escape\", \"Tab\", \"ctrl+l\", \"alt+F4\" or \"super\". Answers with a fresh picture of the screen.".to_string(),
            object_schema(
                json!({
                    "keys": {
                        "type": "string",
                        "description": "A key name, or names joined with \"+\", in X11 keysym spelling."
                    }
                }),
                &["keys"],
            ),
            |desktop, input: KeyInput| async move { desktop.key(input).await },
        ),
    );
    tools.insert(
        "computer_scroll".to_string(),
        desktop_tool(
            &desktop,
            format!(
                "Scroll the mouse wheel over a point on your desktop. {place} Answers with a fresh picture of the screen."
            ),
            object_schema(
                json!({
                    "x": { "type": "number", "description": "Pixels from the left edge." },
                    "y": { "type": "number", "description": "Pixels from the top edge." },
                    "direction": { "type": "string", "enum": ["up", "down"] },
                    "clicks": {
                        "description": "Wheel clicks; defaults to 3.",
                        "type": "integer",
                        "minimum": 1,
                        "maximum": 20
                    }
                }),
                &["x", "y", "direction"],
            ),
            |desktop, input: ScrollInput| async move { desktop.scroll(input).await },
        ),
    );
    tools
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tools::schema_fixture::{definitions, fixture_group};

    /// A computer that answers every call with an empty success, at the default picture.
    struct Quiet;

    #[async_trait]
    impl ComputerBrowser for Quiet {
        async fn browse(&self, command: BrowserCommand) -> anyhow::Result<BrowserResult> {
            Ok(BrowserResult::message(true, command.action.as_str()))
        }
        async fn look_at_screen(&self) -> anyhow::Result<ScreenLook> {
            Ok(ScreenLook::default())
        }
    }

    #[async_trait]
    impl ComputerDesktop for Quiet {
        fn width(&self) -> i64 {
            1280
        }
        fn height(&self) -> i64 {
            720
        }
        async fn list_elements(&self, _: ListElementsInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn list_windows(&self) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn window_action(&self, _: WindowActionInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn find_text(&self, _: FindTextInput) -> anyhow::Result<FindTextResult> {
            Ok(FindTextResult::default())
        }
        async fn click_text(&self, _: ClickTextInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn move_pointer(&self, input: MoveInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::new(
                true,
                format!("{} {}", input.x, input.y),
            ))
        }
        async fn click(&self, _: ClickInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn drag(&self, _: DragInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn type_text(&self, _: TypeInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn key(&self, _: KeyInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
        async fn scroll(&self, _: ScrollInput) -> anyhow::Result<DesktopActionResult> {
            Ok(DesktopActionResult::default())
        }
    }

    #[async_trait]
    impl ComputerUserScreen for Quiet {
        async fn look_at_user_screen(&self) -> anyhow::Result<UserScreenResult> {
            Ok(UserScreenResult::default())
        }
    }

    fn tools(named: bool, user_screen: bool) -> ToolSet {
        let quiet = Arc::new(Quiet);
        create_computer_tools(
            quiet.clone(),
            Some(quiet.clone()),
            user_screen.then(|| quiet as Arc<dyn ComputerUserScreen>),
            named,
        )
    }

    #[test]
    fn sends_the_tools_the_fixture_holds_byte_for_byte() {
        let built = tools(false, false);
        let names: Vec<&str> = built.keys().map(String::as_str).collect();
        assert_eq!(
            names,
            vec![
                "computer_elements",
                "computer_windows",
                "computer_window",
                "computer_click_text",
                "computer_find_text",
                "computer_move",
                "computer_click",
                "computer_drag",
                "computer_type",
                "computer_key",
                "computer_scroll",
                "computer_browse",
                "computer_screen",
            ]
        );
        // The fixture's `computer_screen` is the one `tools::computer` puts in its place.
        let expected: Vec<Value> = fixture_group("computer:chat")
            .into_iter()
            .filter(|entry| names[..names.len() - 1].contains(&entry["name"].as_str().unwrap()))
            .collect();
        let mut actual = definitions(&built);
        actual.pop();
        assert_eq!(actual, expected);
        assert_eq!(
            serde_json::to_string(&actual).unwrap(),
            serde_json::to_string(&expected).unwrap()
        );
    }

    #[test]
    fn offers_the_users_screen_first_and_with_no_computer_to_name() {
        let built = tools(true, true);
        assert_eq!(
            built.keys().next().map(String::as_str),
            Some("computer_user_screen")
        );
        let screen = built["computer_user_screen"].input_schema.json_schema();
        assert_eq!(screen["properties"], json!({}));
        for (name, item) in built.iter().skip(1) {
            let properties = item.input_schema.json_schema()["properties"]
                .as_object()
                .unwrap();
            let (last, field) = properties.iter().last().unwrap();
            assert_eq!(last, "computer", "{name}");
            assert_eq!(
                serde_json::to_string(field).unwrap(),
                r#"{"description":"The computer to use, by its name in the computers notice. Leave it out for the default the notice names.","type":"string"}"#
            );
        }
    }

    #[test]
    fn names_no_picture_size_once_each_computer_has_its_own() {
        let built = tools(true, false);
        let description = built["computer_move"].description.clone().unwrap();
        assert!(description.contains(
            "Pixel coordinates in the latest picture of that computer's screen, from `computer_screen` or the last action:"
        ));
    }

    #[tokio::test]
    async fn calls_the_computer_with_the_parsed_input() {
        let built = tools(true, false);
        let execute = built["computer_move"].execute.clone().unwrap();
        let output = execute(
            json!({ "x": 12, "y": 34, "computer": "Mac" }),
            crate::ai::ToolExecutionOptions::default(),
        )
        .await
        .unwrap();
        assert_eq!(output, json!({ "success": true, "message": "12 34" }));
    }
}
