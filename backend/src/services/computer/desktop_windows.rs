//! The desktop's windows, by title, through `wmctrl`.
//!
//! A window's title-bar buttons belong to the window manager and are not in the
//! accessibility tree, and at 25 pixels they are the targets the model misses most. So a
//! window is never clicked to be managed: `wmctrl` names it by title and focuses, closes,
//! maximises or restores it directly; `xdotool` minimises, which this `wmctrl` cannot.

use std::sync::LazyLock;

use indexmap::IndexMap;
use regex::Regex;
use serde::{Deserialize, Serialize};

use super::child_process::{DEFAULT_MAX_BUFFER, ExecFileOptions, exec_file, process_env};

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

/// One line of `wmctrl -l -G`: id, workspace (-1 for every workspace), x, y, width,
/// height, host, title.
static WINDOW_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^(0x[0-9a-f]+)\s+(-?\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\S+\s*(.*)$")
        .expect("valid regex")
});

/// Run `wmctrl` or `xdotool` on the display `env` names.
async fn run(file: &str, args: &[&str], env: &IndexMap<String, String>) -> anyhow::Result<String> {
    let args: Vec<String> = args.iter().map(|arg| arg.to_string()).collect();
    let env = process_env(env);
    let stdout = exec_file(
        file,
        &args,
        ExecFileOptions {
            env: &env,
            timeout_ms: COMMAND_TIMEOUT_MS,
            max_buffer: DEFAULT_MAX_BUFFER,
        },
    )
    .await?;
    Ok(String::from_utf8_lossy(&stdout).into_owned())
}

/// The windows `wmctrl -l -G` printed, top to bottom, without the desktop's furniture.
fn parse_windows(stdout: &str) -> Vec<DesktopWindow> {
    let mut windows = Vec::new();
    for line in stdout.split('\n') {
        let Some(m) = WINDOW_LINE.captures(line) else {
            continue;
        };
        let title = crate::support::js::trim(&m[7]).to_string();
        if &m[2] == "-1" || FURNITURE.contains(&title.as_str()) || title.is_empty() {
            continue;
        }
        let number = |i: usize| m[i].parse::<i64>().unwrap_or(0);
        windows.push(DesktopWindow {
            id: m[1].to_string(),
            title,
            x: number(3),
            y: number(4),
            width: number(5),
            height: number(6),
        });
    }
    windows.sort_by(|a, b| a.y.cmp(&b.y).then(a.x.cmp(&b.x)));
    windows
}

/// Every window a person would call one, top to bottom.
pub async fn list_windows(env: &IndexMap<String, String>) -> anyhow::Result<Vec<DesktopWindow>> {
    let stdout = run("wmctrl", &["-l", "-G"], env).await?;
    Ok(parse_windows(&stdout))
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
    let id = window.id.as_str();
    match action {
        WindowAction::Focus => {
            run("wmctrl", &["-i", "-a", id], env).await?;
        }
        WindowAction::Close => {
            run("wmctrl", &["-i", "-c", id], env).await?;
        }
        WindowAction::Maximize => {
            run(
                "wmctrl",
                &["-i", "-r", id, "-b", "add,maximized_vert,maximized_horz"],
                env,
            )
            .await?;
        }
        WindowAction::Restore => {
            run(
                "wmctrl",
                &["-i", "-r", id, "-b", "remove,maximized_vert,maximized_horz"],
                env,
            )
            .await?;
            run("wmctrl", &["-i", "-r", id, "-b", "remove,hidden"], env).await?;
        }
        WindowAction::Minimize => {
            run("xdotool", &["windowminimize", id], env).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn window(id: &str, title: &str, x: i64, y: i64, width: i64, height: i64) -> DesktopWindow {
        DesktopWindow {
            id: id.to_string(),
            title: title.to_string(),
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn prefers_an_exact_title_else_titles_containing_the_words() {
        let windows = vec![
            window("0x1", "Terminal - node@box: /app", 4, 95, 819, 488),
            window(
                "0x2",
                "About the Xfce Desktop Environment",
                614,
                95,
                666,
                600,
            ),
            window("0x3", "Terminal", 384, 328, 619, 298),
        ];
        let ids = |query: &str| -> Vec<String> {
            find_windows(&windows, query)
                .into_iter()
                .map(|w| w.id.clone())
                .collect()
        };
        assert_eq!(ids("Terminal"), vec!["0x3"]);
        assert_eq!(ids("xfce"), vec!["0x2"]);
        assert_eq!(ids("node@box"), vec!["0x1"]);
        assert!(ids("Mail").is_empty());
    }

    #[test]
    fn lists_the_windows_a_person_would_call_one_top_to_bottom() {
        let stdout = [
            "0x01e00003 -1 0    0    1920 30   box xfce4-panel",
            "0x01a00004  0 614  95   666  600  box About the Xfce Desktop Environment",
            "0x01c00004  0 4    95   819  488  box Terminal - node@box: /app",
            "0x01400003 -1 0    0    1920 1080 box Desktop",
            "0x01800004  0 10   20   100  100  box ",
        ]
        .join("\n");
        assert_eq!(
            parse_windows(&stdout),
            vec![
                window("0x01c00004", "Terminal - node@box: /app", 4, 95, 819, 488),
                window(
                    "0x01a00004",
                    "About the Xfce Desktop Environment",
                    614,
                    95,
                    666,
                    600
                ),
            ]
        );
    }
}
