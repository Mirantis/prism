//! Workspace path helpers, ported from the upstream Lens Agents shell
//! sandbox.
//!
//! - `resolve_path` turns a tool-supplied path into an absolute path.
//!   Relative paths are resolved from the workspace root; absolute
//!   paths pass through as-is.
//! - `is_inside_workspace` reports whether a normalized path is contained
//!   within the workspace root. Callers use it to reject writes that
//!   would escape the workspace via `..` traversal. It is **not** a
//!   security boundary — the real boundary is filesystem permissions
//!   (matches upstream's semantics: absolute paths outside the
//!   workspace pass through and the check returns false).

const SEP: char = '/';

/// Collapse `.` and `..` while keeping a path absolute or relative: a leading
/// `..` of an absolute path is dropped, of a relative one kept.
fn normalize(p: &str) -> String {
    let is_abs = p.starts_with(SEP);
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split(SEP) {
        if seg.is_empty() || seg == "." {
            continue;
        }
        if seg == ".." {
            if parts.last().is_some_and(|last| *last != "..") {
                parts.pop();
            } else if !is_abs {
                parts.push("..");
            }
            continue;
        }
        parts.push(seg);
    }
    let joined = parts.join("/");
    if is_abs { format!("/{joined}") } else { joined }
}

/// `path.join(a, b)`: the two joined by a separator and normalized, `.` when
/// that leaves nothing.
fn path_join(a: &str, b: &str) -> String {
    let joined = if a.is_empty() {
        b.to_string()
    } else if b.is_empty() {
        a.to_string()
    } else {
        format!("{a}/{b}")
    };
    let trailing = joined.ends_with('/');
    let mut normalized = normalize(&joined);
    if normalized.is_empty() {
        return ".".to_string();
    }
    if trailing && !normalized.ends_with('/') {
        normalized.push('/');
    }
    normalized
}

pub fn resolve_path(workspace: &str, input_path: &str) -> String {
    if input_path.starts_with(SEP) {
        return normalize(input_path);
    }
    normalize(&path_join(workspace, input_path))
}

pub fn is_inside_workspace(full_path: &str, workspace: &str) -> bool {
    let normalized = normalize(full_path);
    let normalized_workspace = normalize(workspace);
    if normalized == normalized_workspace {
        return true;
    }
    normalized.starts_with(&format!("{normalized_workspace}{SEP}"))
}
