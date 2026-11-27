//! Attachment metadata and the helpers of the `/attach` and `/save` flows.
//!
//! Files are uploaded to the runtime's `POST /agents/attachments` and staged
//! until the next chat message names their ids. The server detects the media
//! type and enforces the size cap; the checks here are a fast local guard.

use std::path::{MAIN_SEPARATOR, Path, PathBuf};

use crate::config::home_dir;
use crate::protocol::{AttachmentMeta, Role, TuiMessage};

/// The runtime's per-file limit, mirrored for the local pre-check.
pub const MAX_ATTACHMENT_BYTES: f64 = 10.0 * 1024.0 * 1024.0;

/// The most files one message names, mirrored for the local guard.
pub const MAX_ATTACHMENTS_PER_MESSAGE: usize = 100;

/// A byte count as people read it, such as `1.2 MB`.
pub fn format_file_size(bytes: f64) -> String {
    if bytes < 1024.0 {
        return format!("{} B", crate::util::js_number(bytes));
    }
    let units = ["KB", "MB", "GB"];
    let mut value = bytes / 1024.0;
    let mut i = 0;
    while value >= 1024.0 && i < units.len() - 1 {
        value /= 1024.0;
        i += 1;
    }
    format!("{} {}", to_fixed_1(value), units[i])
}

/// `Number.prototype.toFixed(1)`, which takes the larger of two equally near values.
fn to_fixed_1(value: f64) -> String {
    let tenths = (value * 10.0).round();
    format!("{:.1}", tenths / 10.0)
}

/// Expand a leading `~` (alone, `~/…`, or `~\…` on Windows) to the home directory.
pub fn expand_path(p: &str) -> String {
    if p == "~" {
        return home_dir().display().to_string();
    }
    let sep_prefix = format!("~{MAIN_SEPARATOR}");
    if p.starts_with("~/") || p.starts_with(&sep_prefix) {
        return home_dir().join(&p[2..]).display().to_string();
    }
    p.to_string()
}

/// `path.resolve(cwd, p)`: an absolute path, normalized.
pub fn resolve(cwd: &Path, p: &str) -> PathBuf {
    let joined = if Path::new(p).is_absolute() {
        PathBuf::from(p)
    } else {
        cwd.join(p)
    };
    normalize(&joined)
}

fn normalize(path: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

#[derive(Clone, Debug, PartialEq)]
pub struct PathSuggestion {
    /// What the popup shows: the entry name, with a trailing '/' for a directory.
    pub display: String,
    /// The whole argument after `/attach `: the typed directory part, the name, and '/' for a directory.
    pub insert: String,
    pub is_directory: bool,
}

const MAX_SUGGESTIONS: usize = 24;

/// Local path suggestions for the partial path typed after `/attach `.
pub fn list_path_suggestions(partial: &str, cwd: &Path) -> Vec<PathSuggestion> {
    let last_slash = partial
        .rfind('/')
        .into_iter()
        .chain(partial.rfind(MAIN_SEPARATOR))
        .max();
    let (dir_part, base) = match last_slash {
        Some(i) => (&partial[..=i], &partial[i + 1..]),
        None => ("", partial),
    };
    let dir = if dir_part.is_empty() { "." } else { dir_part };
    let abs_dir = resolve(cwd, &expand_path(dir));
    let Ok(read) = std::fs::read_dir(&abs_dir) else {
        return Vec::new();
    };
    let show_hidden = base.starts_with('.');
    let mut entries: Vec<(String, bool)> = read
        .filter_map(Result::ok)
        .map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
            (name, is_dir)
        })
        .filter(|(name, _)| name.starts_with(base) && (show_hidden || !name.starts_with('.')))
        .collect();
    entries.sort_by(|(a, a_dir), (b, b_dir)| {
        b_dir
            .cmp(a_dir)
            .then_with(|| crate::util::locale_compare(a, b))
    });
    entries
        .into_iter()
        .take(MAX_SUGGESTIONS)
        .map(|(name, is_directory)| {
            let suffix = if is_directory { "/" } else { "" };
            PathSuggestion {
                display: format!("{name}{suffix}"),
                insert: format!("{dir_part}{name}{suffix}"),
                is_directory,
            }
        })
        .collect()
}

/// The files of the latest run that delivered any: every reply since the user's
/// last message, oldest first. A goal, scheduled or heartbeat message is a run of
/// its own, offered only when it is the newest message with files.
pub fn latest_turn_attachments(messages: &[&TuiMessage]) -> Vec<AttachmentMeta> {
    let mut turn: Vec<&Vec<AttachmentMeta>> = Vec::new();
    for m in messages.iter().rev() {
        if m.role == Role::User {
            if !turn.is_empty() {
                break;
            }
            continue;
        }
        let Some(attachments) = m.attachments.as_ref().filter(|a| !a.is_empty()) else {
            continue;
        };
        if m.role != Role::Agent {
            continue;
        }
        let chat_reply = m.triggered_by == "USER_INPUT";
        if !turn.is_empty() && !chat_reply {
            continue;
        }
        turn.insert(0, attachments);
        if !chat_reply {
            break;
        }
    }
    let mut seen = std::collections::HashSet::new();
    turn.into_iter()
        .flatten()
        .filter(|a| seen.insert(a.id.clone()))
        .cloned()
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn formats_sizes_like_the_runtime() {
        assert_eq!(format_file_size(512.0), "512 B");
        assert_eq!(format_file_size(1280.0), "1.3 KB");
        assert_eq!(format_file_size(1536.0 * 1024.0), "1.5 MB");
    }

    #[test]
    fn suggests_directories_first() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir(dir.path().join("beta")).unwrap();
        std::fs::write(dir.path().join("alpha.txt"), "x").unwrap();
        std::fs::write(dir.path().join(".hidden"), "x").unwrap();
        let s = list_path_suggestions("", dir.path());
        let names: Vec<_> = s.iter().map(|s| s.display.clone()).collect();
        assert_eq!(names, vec!["beta/", "alpha.txt"]);
        let hidden = list_path_suggestions(".", dir.path());
        assert_eq!(hidden[0].display, ".hidden");
    }

    fn msg(role: &str, trig: &str, ids: &[&str]) -> TuiMessage {
        let atts: Vec<_> = ids
            .iter()
            .map(|i| json!({"id":i,"filename":format!("{i}.png"),"sizeBytes":1}))
            .collect();
        crate::protocol::coerce_message(&json!({"id":uuid::Uuid::new_v4().to_string(),"content":"x","role":role,"triggeredBy":trig,"attachments":atts})).unwrap()
    }

    #[test]
    fn collects_the_files_of_the_latest_turn() {
        let a = msg("USER", "USER_INPUT", &[]);
        let b = msg("AGENT", "USER_INPUT", &["one"]);
        let c = msg("AGENT", "CRON_TASK", &["cron"]);
        let d = msg("AGENT", "USER_INPUT", &["two"]);
        let files = latest_turn_attachments(&[&a, &b, &c, &d]);
        let ids: Vec<_> = files.iter().map(|f| f.id.as_str()).collect();
        assert_eq!(ids, vec!["one", "two"]);
        let cron_last = latest_turn_attachments(&[&a, &b, &c]);
        assert_eq!(cron_last[0].id, "cron");
    }
}
