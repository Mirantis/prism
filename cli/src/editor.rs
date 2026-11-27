//! Editing a document in the user's own editor.
//!
//! The TUI hands the text to `$VISUAL` / `$EDITOR` in a temp file and reads it
//! back when the editor exits, as `git commit` does. The temp file outlives the
//! call: the caller removes it (`discard`) only after the edit is stored, so a
//! failed save can point at the file that still holds the work.

use std::path::PathBuf;
use std::process::Command;

pub struct EditResult {
    /// The document after editing: the original text when nothing was saved.
    pub text: String,
    /// False when the editor exited without changing the file, or abandoned it.
    pub changed: bool,
    /// Where the edited text still sits on disk.
    pub file: PathBuf,
    dir: PathBuf,
}

impl EditResult {
    /// Remove the temp file and its directory. Safe to call more than once.
    pub fn discard(&self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// `$VISUAL`, else `$EDITOR`, else `vi`. An empty or all-space value means "not set".
pub fn resolve_editor() -> String {
    resolve_editor_from(std::env::var("VISUAL").ok(), std::env::var("EDITOR").ok())
}

fn resolve_editor_from(visual: Option<String>, editor: Option<String>) -> String {
    let visual = visual.unwrap_or_default().trim().to_string();
    let editor = editor.unwrap_or_default().trim().to_string();
    if !visual.is_empty() {
        return visual;
    }
    if !editor.is_empty() {
        return editor;
    }
    "vi".into()
}

/// Open `initial` in the user's editor and return what they saved. The editor owns
/// the terminal while it runs, so the caller hands it over first. A non-zero exit
/// leaves the document alone: it is how `vi`'s `:cq` reports a deliberate abort.
pub fn edit_text(initial: &str, suffix: &str) -> std::io::Result<EditResult> {
    let dir = crate::shell_command::tempfile_dir("prism-edit-")?;
    let file = dir.join(format!("document{suffix}"));
    std::fs::write(&file, initial)?;
    let discard = |dir: &PathBuf| {
        let _ = std::fs::remove_dir_all(dir);
    };
    let editor = resolve_editor();
    // An editor setting may hold flags ("code -w"); whitespace is the only separator.
    let mut parts = editor.split_whitespace();
    let command = parts.next().unwrap_or("vi").to_string();
    let args: Vec<String> = parts.map(str::to_string).collect();
    let status = match Command::new(&command).args(&args).arg(&file).status() {
        Ok(status) => status,
        Err(err) => {
            discard(&dir);
            return Err(err);
        }
    };
    if !status.success() {
        discard(&dir);
        return Ok(EditResult {
            text: initial.into(),
            changed: false,
            file,
            dir,
        });
    }
    let text = std::fs::read_to_string(&file)?;
    if text == initial {
        discard(&dir);
    }
    let changed = text != initial;
    Ok(EditResult {
        text,
        changed,
        file,
        dir,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefers_visual_then_editor_then_vi() {
        assert_eq!(
            resolve_editor_from(Some("nano".into()), Some("vim".into())),
            "nano"
        );
        assert_eq!(
            resolve_editor_from(Some("  ".into()), Some("vim".into())),
            "vim"
        );
        assert_eq!(resolve_editor_from(None, None), "vi");
    }
}
