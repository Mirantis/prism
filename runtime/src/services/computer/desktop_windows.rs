//! The desktop's windows, by title, through `wmctrl`.
//!
//! A window's title-bar buttons belong to the window manager and are not in the
//! accessibility tree, and at 25 pixels they are the targets the model misses most. So a
//! window is never clicked to be managed: `wmctrl` names it by title and focuses, closes,
//! maximises or restores it directly; `xdotool` minimises, which this `wmctrl` cannot.

use std::collections::HashMap;

use indexmap::IndexMap;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DesktopWindow {
    pub id: String,
    pub title: String,
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowAction {
    Focus,
    Close,
    Maximize,
    Restore,
    Minimize,
}

impl WindowAction {
    pub fn as_str(self) -> &'static str {
        match self {
            WindowAction::Focus => "focus",
            WindowAction::Close => "close",
            WindowAction::Maximize => "maximize",
            WindowAction::Restore => "restore",
            WindowAction::Minimize => "minimize",
        }
    }
}

/// A window with a title, as `find_windows` matches it: the desktop's own windows and a
/// remote computer's.
pub trait Titled {
    fn title(&self) -> &str;
}

impl Titled for DesktopWindow {
    fn title(&self) -> &str {
        &self.title
    }
}

const COMMAND_TIMEOUT_MS: u64 = 10_000;
/// The desktop's own furniture, shown by `wmctrl` as windows on every workspace.
const FURNITURE: [&str; 2] = ["xfce4-panel", "Desktop"];

/// Every window a person would call one, top to bottom.
pub async fn list_windows(env: &IndexMap<String, String>) -> anyhow::Result<Vec<DesktopWindow>> {
    todo!()
}

/// The windows whose title is or contains `query`, the way `find_elements` matches names.
pub fn find_windows<'a, W: Titled>(windows: &'a [W], query: &str) -> Vec<&'a W> {
    let wanted = query.to_lowercase();
    let wanted = wanted.trim();
    if wanted.is_empty() {
        return Vec::new();
    }
    let exact: Vec<&W> = windows
        .iter()
        .filter(|w| w.title().to_lowercase() == wanted)
        .collect();
    if !exact.is_empty() {
        return exact;
    }
    windows
        .iter()
        .filter(|w| w.title().to_lowercase().contains(wanted))
        .collect()
}

pub async fn act_on_window(
    env: &IndexMap<String, String>,
    window: &DesktopWindow,
    action: WindowAction,
) -> anyhow::Result<()> {
    todo!()
}
