//! The desktop's controls, by name and rectangle, from the accessibility tree.
//!
//! GTK applications, the XFCE panel and its menus among them, describe every widget over
//! AT-SPI: its role, its name and where it is on the screen. That is the exact answer to
//! "where is Mail Reader", with no picture and no estimate, and it is what lets a click
//! by name land on a widget's centre. A short Python program over `pyatspi` walks the
//! tree and prints the visible, named widgets as JSON; it runs with Debian's Python,
//! since the image's PATH puts a mise-managed one first, which has no `pyatspi`.
//!
//! Not everything is in the tree. The window manager's own title-bar buttons are not
//! widgets (see `desktop_windows.rs`), a plain X11 program describes nothing, and Chromium
//! describes its own frame but not the page unless asked to. OCR (`screen_text.rs`) covers
//! the rest.

use std::collections::HashMap;
use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use super::screen_size::math_round;

/// One visible, named widget, in screen pixels.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ScreenElement {
    pub app: String,
    pub role: String,
    pub name: String,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Debian's interpreter, the one `python3-pyatspi` installs into.
const PYTHON: &str = "/usr/bin/python3";
const DUMP_TIMEOUT_MS: u64 = 15_000;

/// Widgets a person clicks, types into or reads, plus the windows they sit in.
pub const ACTIONABLE_ROLES: [&str; 21] = [
    "menu item",
    "menu",
    "check menu item",
    "radio menu item",
    "push button",
    "toggle button",
    "check box",
    "radio button",
    "page tab",
    "list item",
    "tree item",
    "link",
    "text",
    "entry",
    "password text",
    "combo box",
    "spin button",
    "slider",
    "icon",
    "frame",
    "dialog",
];

/// Whether `role` is one of `ACTIONABLE_ROLES`.
pub fn is_actionable(role: &str) -> bool {
    ACTIONABLE_ROLES.contains(&role)
}

/// The tree walk, with the roles it keeps written in as a JSON list.
static DUMP_SCRIPT: LazyLock<String> = LazyLock::new(|| {
    let mut roles: Vec<&str> = ACTIONABLE_ROLES.to_vec();
    roles.push("label");
    let roles = serde_json::to_string(&roles).expect("a list of strings serializes");
    format!(
        r#"
import json
import pyatspi
ROLES = {roles}
out = []
def walk(acc, depth, app):
    if depth > 14 or len(out) > 800:
        return
    try:
        children = list(acc)
    except Exception:
        return
    for child in children:
        try:
            st = child.getState()
            if not (st.contains(pyatspi.STATE_VISIBLE) and st.contains(pyatspi.STATE_SHOWING)):
                continue
            role = child.getRoleName()
            name = child.name or ""
            if role in ROLES and name:
                x, y, w, h = child.queryComponent().getExtents(pyatspi.DESKTOP_COORDS)
                if w > 0 and h > 0:
                    out.append({{"app": app, "role": role, "name": name, "x": x, "y": y, "width": w, "height": h}})
        except Exception:
            pass
        walk(child, depth + 1, app)
desktop = pyatspi.Registry.getDesktop(0)
for app in desktop:
    try:
        walk(app, 0, app.name or "")
    except Exception:
        pass
print(json.dumps(out))
"#
    )
});

/// Walk the accessibility tree. `env` holds DISPLAY and the session bus address.
pub async fn read_screen_elements(
    env: &IndexMap<String, String>,
) -> anyhow::Result<Vec<ScreenElement>> {
    todo!()
}

/// Letters and digits only, lower case, the same as `screen_text.rs`.
fn normalize(text: &str) -> String {
    text.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn by_position(a: &ScreenElement, b: &ScreenElement) -> std::cmp::Ordering {
    a.y.partial_cmp(&b.y)
        .unwrap_or(std::cmp::Ordering::Equal)
        .then(a.x.partial_cmp(&b.x).unwrap_or(std::cmp::Ordering::Equal))
}

/// The widgets whose name is `query`, top to bottom: a whole-name match first, then names
/// that contain the query, so "Close" finds "Close" before "Close all tabs". Only widgets a
/// person acts on; a plain label is not a target.
pub fn find_elements(elements: &[ScreenElement], query: &str) -> Vec<ScreenElement> {
    let wanted = normalize(query);
    if wanted.is_empty() {
        return Vec::new();
    }
    let candidates: Vec<&ScreenElement> =
        elements.iter().filter(|e| is_actionable(&e.role)).collect();
    let exact: Vec<ScreenElement> = candidates
        .iter()
        .filter(|e| normalize(&e.name) == wanted)
        .map(|e| (*e).clone())
        .collect();
    let mut found = if !exact.is_empty() {
        exact
    } else {
        candidates
            .iter()
            .filter(|e| normalize(&e.name).contains(&wanted))
            .map(|e| (*e).clone())
            .collect()
    };
    found.sort_by(by_position);
    found
}

/// The controls as a reading for the model, grouped by program, the way `browse` reports a
/// page's controls. Windows first in each group, then the rest top to bottom.
pub fn describe_elements(elements: &[ScreenElement], filter: Option<&str>) -> String {
    let wanted = filter
        .filter(|f| !f.is_empty())
        .map(normalize)
        .unwrap_or_default();
    let shown: Vec<&ScreenElement> = elements
        .iter()
        .filter(|e| {
            is_actionable(&e.role) && (wanted.is_empty() || normalize(&e.name).contains(&wanted))
        })
        .collect();
    if shown.is_empty() {
        return match filter.filter(|f| !f.is_empty()) {
            Some(filter) => format!("No control named like \"{filter}\" is on the screen."),
            None => "No controls are on the screen.".to_string(),
        };
    }

    let mut by_app: IndexMap<&str, Vec<&ScreenElement>> = IndexMap::new();
    for e in shown {
        by_app.entry(e.app.as_str()).or_default().push(e);
    }
    let mut lines = Vec::new();
    for (app, mut items) in by_app {
        lines.push(format!(
            "{}:",
            if app.is_empty() {
                "unknown program"
            } else {
                app
            }
        ));
        items.sort_by(|a, b| {
            ((b.role == "frame") as i32)
                .cmp(&((a.role == "frame") as i32))
                .then_with(|| by_position(a, b))
        });
        for e in items {
            let cx = math_round(e.x + e.width / 2.0) as i64;
            let cy = math_round(e.y + e.height / 2.0) as i64;
            lines.push(format!("  {} \"{}\" at ({cx}, {cy})", e.role, e.name));
        }
    }
    lines.join("\n")
}
