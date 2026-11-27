//! Commands about files: `/attach`, `/detach`, `/save` and `/copy`.

use std::collections::HashSet;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use super::CommandContext;
use crate::attachments::{MAX_ATTACHMENTS_PER_MESSAGE, expand_path, format_file_size, resolve};
use crate::event::AppEvent;

fn cwd() -> PathBuf {
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

pub async fn attach(c: &CommandContext) -> String {
    if c.raw_args.is_empty() {
        if c.staged_attachments.is_empty() {
            return "No files staged. Usage: /attach <path>.".into();
        }
        return c
            .staged_attachments
            .iter()
            .map(|a| format!("📎 {} ({})", a.filename, format_file_size(a.size_bytes)))
            .collect::<Vec<_>>()
            .join("\n");
    }
    if c.staged_attachments.len() >= MAX_ATTACHMENTS_PER_MESSAGE {
        return format!(
            "Already at the {MAX_ATTACHMENTS_PER_MESSAGE}-file limit for one message. Send or /detach first."
        );
    }
    // The raw arguments keep inner spaces, so "My Notes/todo.txt" works unquoted.
    let path = resolve(&cwd(), &expand_path(&c.raw_args));
    match c.ctx.api.upload_attachment(&path).await {
        Ok(att) => {
            let line = format!(
                "Staged 📎 {} ({}) — sends with your next message. {} file(s) staged.",
                att.filename,
                format_file_size(att.size_bytes),
                c.staged_attachments.len() + 1
            );
            c.ctx.send(AppEvent::Stage(att));
            line
        }
        Err(e) => e.message,
    }
}

pub async fn detach(c: &CommandContext) -> String {
    let staged = &c.staged_attachments;
    if staged.is_empty() {
        return "No files staged.".into();
    }
    // Best effort: the runtime reaps unlinked uploads anyway.
    for att in staged {
        let _ = c.ctx.api.delete_attachment(&att.id).await;
    }
    c.ctx.send(AppEvent::ClearStaged);
    format!("Removed {} staged file(s).", staged.len())
}

/// `chart.png`, else `chart-2.png`, `chart-3.png`…: one path per file of this save.
fn free_path(wanted: PathBuf, taken: &mut HashSet<PathBuf>) -> PathBuf {
    let mut candidate = wanted.clone();
    let dir = wanted.parent().map(Path::to_path_buf).unwrap_or_default();
    let stem = wanted
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = wanted
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    let mut n = 2;
    while taken.contains(&candidate) {
        candidate = dir.join(format!("{stem}-{n}{ext}"));
        n += 1;
    }
    taken.insert(candidate.clone());
    candidate
}

pub async fn save(c: &CommandContext) -> String {
    let files = &c.recent_attachments;
    if files.is_empty() {
        return "No files from the agent to save.".into();
    }
    let dest = c.raw_args.trim();
    let cwd = cwd();
    let mut single_file: Option<PathBuf> = None;
    let target_dir = if dest.is_empty() {
        cwd.clone()
    } else {
        let resolved = resolve(&cwd, &expand_path(dest));
        let ends_with_sep = dest.ends_with('/') || dest.ends_with('\\');
        let meta = std::fs::metadata(&resolved).ok();
        let exists_as_dir = meta.as_ref().is_some_and(|m| m.is_dir());
        let exists_as_file = meta.as_ref().is_some_and(|m| m.is_file());
        if exists_as_dir || ends_with_sep || (!exists_as_file && files.len() > 1) {
            resolved
        } else if files.len() == 1 {
            let dir = resolved
                .parent()
                .map(Path::to_path_buf)
                .unwrap_or_else(|| cwd.clone());
            single_file = Some(resolved);
            dir
        } else {
            return format!(
                "\"{dest}\" is an existing file but {} files are pending — give a directory instead.",
                files.len()
            );
        }
    };
    if let Err(e) = std::fs::create_dir_all(&target_dir) {
        return format!("Could not create {}: {e}", target_dir.display());
    }
    let mut saved: Vec<String> = Vec::new();
    let mut failed: Vec<String> = Vec::new();
    let mut taken = HashSet::new();
    for att in files {
        // Only the base name: a server-supplied filename never picks the directory.
        let base = Path::new(&att.filename)
            .file_name()
            .map(|n| n.to_owned())
            .unwrap_or_default();
        let out = single_file
            .clone()
            .unwrap_or_else(|| free_path(target_dir.join(base), &mut taken));
        let result = match c.ctx.api.download_attachment(&att.id).await {
            Ok(bytes) => std::fs::write(&out, bytes).map_err(|e| e.to_string()),
            Err(e) => Err(e.message),
        };
        match result {
            Ok(()) => saved.push(out.display().to_string()),
            Err(e) => failed.push(format!("Failed to save {}: {e}", att.filename)),
        }
    }
    let mut lines: Vec<String> = Vec::new();
    if !saved.is_empty() {
        lines.push(format!("Saved {} file(s):", saved.len()));
        lines.extend(saved.iter().map(|p| format!("  {p}")));
    }
    lines.extend(failed);
    lines.join("\n")
}

fn copy_to_clipboard(text: &str) -> Result<(), String> {
    let (cmd, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("pbcopy", &[])
    } else if cfg!(windows) {
        ("clip", &[])
    } else {
        ("xclip", &["-selection", "clipboard"])
    };
    let mut child = Command::new(cmd)
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| match e.kind() {
            // Node's wording, which names the missing program.
            std::io::ErrorKind::NotFound => format!("spawn {cmd} ENOENT"),
            _ => format!("spawn {cmd}: {e}"),
        })?;
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(text.as_bytes());
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!(
            "{cmd} exited with code {}",
            status
                .code()
                .map(|c| c.to_string())
                .unwrap_or_else(|| "null".into())
        ))
    }
}

pub async fn copy(c: &CommandContext) -> String {
    let Some(text) = c.last_message_content.clone().filter(|t| !t.is_empty()) else {
        return "No message to copy yet.".into();
    };
    match tokio::task::spawn_blocking(move || copy_to_clipboard(&text)).await {
        Ok(Ok(())) => "Copied last message to clipboard.".into(),
        Ok(Err(detail)) => format!("Failed to copy: {detail}"),
        Err(e) => format!("Failed to copy: {e}"),
    }
}
