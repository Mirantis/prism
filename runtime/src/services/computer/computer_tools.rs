//! Browser, desktop, and shared-screen tools for the agent's computer.

use std::sync::{Arc, LazyLock};

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

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
            "type": "string",
            "description": "The computer to use, by its name in the computers notice. Leave it out for the default the notice names."
        }
    })
});

/// The tools, with `computer` on each one that acts on a computer when `named`. The user's
/// shared screen is not on any computer, so its tool takes none.
///
/// The order is the one the tools block sends: `computer_user_screen` (with a user screen),
/// the desktop tools (with a desktop: `computer_elements`, `computer_windows`,
/// `computer_window`, `computer_click_text`, `computer_find_text`, `computer_move`,
/// `computer_click`, `computer_drag`, `computer_type`, `computer_key`, `computer_scroll`),
/// then `computer_browse` and `computer_screen`. Each description and input schema is the
/// TypeScript's, byte for byte.
pub fn create_computer_tools(
    browser: Arc<dyn ComputerBrowser>,
    desktop: Option<Arc<dyn ComputerDesktop>>,
    user_screen: Option<Arc<dyn ComputerUserScreen>>,
    named: bool,
) -> ToolSet {
    todo!()
}

/// The tools before `computer` is added to them.
fn computer_tools(
    browser: Arc<dyn ComputerBrowser>,
    desktop: Option<Arc<dyn ComputerDesktop>>,
    user_screen: Option<Arc<dyn ComputerUserScreen>>,
    named: bool,
) -> ToolSet {
    todo!()
}

/// The desktop tools. Each computer's picture has its own size, which every picture's
/// answer states, so with `named` the coordinate text names no size.
fn create_desktop_tools(desktop: Arc<dyn ComputerDesktop>, named: bool) -> ToolSet {
    todo!()
}
