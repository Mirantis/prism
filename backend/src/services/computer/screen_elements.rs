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

use std::sync::LazyLock;

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::child_process::{ExecFileOptions, exec_file, process_env};
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
    let env = process_env(env);
    let stdout = exec_file(
        PYTHON,
        &["-c".to_string(), DUMP_SCRIPT.clone()],
        ExecFileOptions {
            env: &env,
            timeout_ms: DUMP_TIMEOUT_MS,
            max_buffer: 4 * 1024 * 1024,
        },
    )
    .await?;
    let parsed: Value = serde_json::from_slice(&stdout)?;
    let Value::Array(items) = parsed else {
        return Ok(Vec::new());
    };
    Ok(items.iter().filter_map(element_of).collect())
}

/// One element of the dump, when it names itself. The rest of its fields are the dump's
/// own, so a field that is not there reads as empty.
fn element_of(value: &Value) -> Option<ScreenElement> {
    let item = value.as_object()?;
    let name = item.get("name")?.as_str()?.to_string();
    let text = |key: &str| {
        item.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };
    let number = |key: &str| item.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN);
    Some(ScreenElement {
        app: text("app"),
        role: text("role"),
        name,
        x: number("x"),
        y: number("y"),
        width: number("width"),
        height: number("height"),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn element(app: &str, role: &str, name: &str, x: f64, y: f64, w: f64, h: f64) -> ScreenElement {
        ScreenElement {
            app: app.to_string(),
            role: role.to_string(),
            name: name.to_string(),
            x,
            y,
            width: w,
            height: h,
        }
    }

    /// What the tree dump produced on the desktop with a terminal open and the About dialog
    /// in front of it.
    fn elements() -> Vec<ScreenElement> {
        vec![
            element(
                "xfce4-panel",
                "toggle button",
                "Applications",
                0.0,
                0.0,
                116.0,
                26.0,
            ),
            element(
                "xfce4-panel",
                "toggle button",
                "Terminal - node@box: /app",
                124.0,
                0.0,
                200.0,
                26.0,
            ),
            element(
                "xfce4-panel",
                "toggle button",
                "About the Xfce Desktop Environment",
                324.0,
                0.0,
                200.0,
                26.0,
            ),
            element(
                "xfce4-terminal",
                "frame",
                "Terminal - node@box: /app",
                0.0,
                27.0,
                823.0,
                524.0,
            ),
            element("xfce4-terminal", "menu", "File", 5.0, 64.0, 48.0, 24.0),
            element("xfce4-terminal", "menu", "Edit", 53.0, 64.0, 48.0, 24.0),
            element(
                "xfce4-about",
                "dialog",
                "About the Xfce Desktop Environment",
                610.0,
                27.0,
                670.0,
                636.0,
            ),
            element("xfce4-about", "page tab", "System", 642.0, 81.0, 48.0, 24.0),
            element("xfce4-about", "page tab", "About", 716.0, 81.0, 40.0, 24.0),
            element(
                "xfce4-about",
                "page tab",
                "Credits",
                782.0,
                81.0,
                56.0,
                24.0,
            ),
            element("xfce4-about", "page tab", "Debian", 864.0, 81.0, 48.0, 24.0),
            element(
                "xfce4-about",
                "label",
                "Distributor",
                797.0,
                198.0,
                112.0,
                17.0,
            ),
            element("xfce4-about", "label", "Debian", 921.0, 198.0, 336.0, 17.0),
            element(
                "xfce4-about",
                "push button",
                "Close",
                1184.0,
                617.0,
                86.0,
                36.0,
            ),
        ]
    }

    fn names(found: &[ScreenElement]) -> Vec<&str> {
        found.iter().map(|e| e.name.as_str()).collect()
    }

    #[test]
    fn finds_a_control_by_its_whole_name_ignoring_case_and_punctuation() {
        let all = elements();
        assert_eq!(find_elements(&all, "credits")[0].name, "Credits");
        assert_eq!(find_elements(&all, "Close.").len(), 1);
    }

    #[test]
    fn prefers_a_whole_name_match_over_names_that_merely_contain_the_query() {
        let all = elements();
        let found = find_elements(&all, "About");
        assert_eq!(names(&found), vec!["About"]);
        assert_eq!(found[0].role, "page tab");
    }

    #[test]
    fn falls_back_to_names_containing_the_query() {
        assert_eq!(
            names(&find_elements(&elements(), "Credit")),
            vec!["Credits"]
        );
    }

    #[test]
    fn never_returns_a_plain_label_which_is_not_a_target() {
        let all = elements();
        let roles: Vec<String> = find_elements(&all, "Debian")
            .into_iter()
            .map(|e| e.role)
            .collect();
        assert_eq!(roles, vec!["page tab"]);
        assert!(find_elements(&all, "Distributor").is_empty());
    }

    #[test]
    fn answers_empty_for_a_name_that_is_not_there() {
        assert!(find_elements(&elements(), "Web Browser").is_empty());
    }

    #[test]
    fn groups_controls_by_program_with_their_centres_windows_first() {
        let text = describe_elements(&elements(), None);
        assert!(text.contains("xfce4-about:"));
        assert!(text.contains("page tab \"Credits\" at (810, 93)"));
        let terminal = &text[text.find("xfce4-terminal:").unwrap()..];
        assert!(
            terminal.find("frame \"Terminal").unwrap() < terminal.find("menu \"File\"").unwrap()
        );
        assert!(!text.contains("label \"Distributor\""));
    }

    #[test]
    fn filters_by_name_and_says_when_nothing_matches() {
        let all = elements();
        assert!(describe_elements(&all, Some("credit")).contains("page tab \"Credits\""));
        assert!(!describe_elements(&all, Some("credit")).contains("Applications"));
        assert!(describe_elements(&all, Some("nothing here")).contains("No control named like"));
    }

    #[test]
    fn keeps_each_dumped_element_that_names_itself() {
        let dump = serde_json::json!([
            { "app": "xfce4-panel", "role": "menu", "name": "File", "x": 1, "y": 2, "width": 3, "height": 4 },
            { "app": "xfce4-panel", "role": "menu", "x": 1, "y": 2, "width": 3, "height": 4 },
            "not an element",
        ]);
        let kept: Vec<ScreenElement> = dump
            .as_array()
            .unwrap()
            .iter()
            .filter_map(element_of)
            .collect();
        assert_eq!(
            kept,
            vec![element("xfce4-panel", "menu", "File", 1.0, 2.0, 3.0, 4.0)]
        );
    }
}
