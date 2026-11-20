//! Workspace path helpers, ported from the upstream Mirantis Agent Platform shell
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
//!
//! Both follow the platform's path rules: `/` on Unix; on Windows `\` or `/`
//! separate, a drive (`C:\`) or UNC share (`\\server\share`) is the root, and
//! the result uses `\`.

#[cfg(not(windows))]
use posix as rules;
#[cfg(windows)]
use win32 as rules;

pub fn resolve_path(workspace: &str, input_path: &str) -> String {
    rules::resolve_path(workspace, input_path)
}

pub fn is_inside_workspace(full_path: &str, workspace: &str) -> bool {
    rules::is_inside_workspace(full_path, workspace)
}

/// The last segment of `p`, as Node's `path.basename`: a Windows path from
/// `resolve_path` uses `\`, so splitting on `/` alone would return it whole.
pub fn basename(p: &str) -> &str {
    rules::basename(p)
}

/// Collapse `.` and `..` in the segments after `root`: a `..` above an
/// absolute root is dropped, one in a relative path kept.
fn collapse<'a>(segments: impl Iterator<Item = &'a str>, is_abs: bool) -> Vec<&'a str> {
    let mut parts: Vec<&str> = Vec::new();
    for seg in segments {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|last| *last != "..") {
                    parts.pop();
                } else if !is_abs {
                    parts.push("..");
                }
            }
            other => parts.push(other),
        }
    }
    parts
}

/// `a` and `b` joined by `sep`, or the one that is not empty.
fn join(a: &str, b: &str, sep: char) -> String {
    match (a.is_empty(), b.is_empty()) {
        (true, _) => b.to_string(),
        (_, true) => a.to_string(),
        _ => format!("{a}{sep}{b}"),
    }
}

mod posix {
    fn normalize(p: &str) -> String {
        let is_abs = p.starts_with('/');
        let joined = super::collapse(p.split('/'), is_abs).join("/");
        if is_abs { format!("/{joined}") } else { joined }
    }

    pub fn resolve_path(workspace: &str, input_path: &str) -> String {
        if input_path.starts_with('/') {
            return normalize(input_path);
        }
        normalize(&super::join(workspace, input_path, '/'))
    }

    pub fn basename(p: &str) -> &str {
        p.trim_end_matches('/').rsplit('/').next().unwrap_or("")
    }

    pub fn is_inside_workspace(full_path: &str, workspace: &str) -> bool {
        let normalized = normalize(full_path);
        let normalized_workspace = normalize(workspace);
        normalized == normalized_workspace
            || normalized.starts_with(&format!("{normalized_workspace}/"))
    }
}

#[cfg_attr(not(windows), allow(dead_code))]
mod win32 {
    fn is_sep(c: char) -> bool {
        c == '\\' || c == '/'
    }

    /// The root of `p` with `\` separators, whether it is absolute, and the
    /// rest. A UNC share `\\server\share`, a drive `C:` with or without a
    /// separator after it, or a lone separator.
    fn split_root(p: &str) -> (String, bool, &str) {
        let chars: Vec<char> = p.chars().take(3).collect();
        if chars.len() >= 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
            let drive = &p[..2];
            let is_abs = chars.get(2).copied().is_some_and(is_sep);
            let rest = if is_abs { &p[3..] } else { &p[2..] };
            let root = if is_abs {
                format!("{drive}\\")
            } else {
                drive.to_string()
            };
            return (root, is_abs, rest);
        }
        if chars.len() >= 2 && is_sep(chars[0]) && is_sep(chars[1]) {
            let mut parts = p[2..].splitn(3, is_sep);
            let server = parts.next().unwrap_or("");
            let share = parts.next().unwrap_or("");
            if !server.is_empty() && !share.is_empty() {
                let rest = parts.next().unwrap_or("");
                return (format!("\\\\{server}\\{share}\\"), true, rest);
            }
        }
        if chars.first().copied().is_some_and(is_sep) {
            return ("\\".to_string(), true, &p[1..]);
        }
        (String::new(), false, p)
    }

    fn normalize(p: &str) -> String {
        let (root, is_abs, rest) = split_root(p);
        let joined = super::collapse(rest.split(is_sep), is_abs).join("\\");
        if is_abs && joined.is_empty() && root.len() > 1 && root.ends_with('\\') {
            // `C:\` and `\\server\share\` keep their separator only when
            // nothing follows; with segments the root ends in one already.
            return root;
        }
        format!("{root}{joined}")
    }

    fn is_absolute(p: &str) -> bool {
        split_root(p).1
    }

    pub fn resolve_path(workspace: &str, input_path: &str) -> String {
        if is_absolute(input_path) {
            return normalize(input_path);
        }
        normalize(&super::join(workspace, input_path, '\\'))
    }

    pub fn basename(p: &str) -> &str {
        // A drive prefix (`C:name`) is not part of the name.
        let chars: Vec<char> = p.chars().take(2).collect();
        let p = if chars.len() == 2 && chars[0].is_ascii_alphabetic() && chars[1] == ':' {
            &p[2..]
        } else {
            p
        };
        p.trim_end_matches(is_sep)
            .rsplit(is_sep)
            .next()
            .unwrap_or("")
    }

    pub fn is_inside_workspace(full_path: &str, workspace: &str) -> bool {
        let normalized = normalize(full_path);
        let normalized_workspace = normalize(workspace);
        if normalized.eq_ignore_ascii_case(&normalized_workspace) {
            return true;
        }
        let prefix = if normalized_workspace.ends_with('\\') {
            normalized_workspace
        } else {
            format!("{normalized_workspace}\\")
        };
        normalized.len() > prefix.len()
            && normalized.is_char_boundary(prefix.len())
            && normalized[..prefix.len()].eq_ignore_ascii_case(&prefix)
    }
}

#[cfg(test)]
mod tests {
    use super::{posix, win32};

    #[test]
    fn basename_follows_the_platform_separators() {
        assert_eq!(posix::basename("/work/out/report.pdf"), "report.pdf");
        assert_eq!(posix::basename("/work/out/"), "out");
        assert_eq!(
            posix::basename(r"C:\work\report.pdf"),
            r"C:\work\report.pdf"
        );
        assert_eq!(win32::basename(r"C:\work\out\report.pdf"), "report.pdf");
        assert_eq!(win32::basename("C:/work/chart.png"), "chart.png");
        assert_eq!(win32::basename(r"\\server\share\a\b.txt"), "b.txt");
        assert_eq!(win32::basename(r"C:\work\out\"), "out");
        assert_eq!(win32::basename("C:report.pdf"), "report.pdf");
        assert_eq!(win32::basename(r"C:\"), "");
    }

    #[test]
    fn resolves_relative_paths_from_the_workspace_root() {
        assert_eq!(
            posix::resolve_path("/home/sandbox", "src/main.rs"),
            "/home/sandbox/src/main.rs"
        );
    }

    #[test]
    fn passes_absolute_paths_through_as_is() {
        assert_eq!(
            posix::resolve_path("/home/sandbox", "/src/main.rs"),
            "/src/main.rs"
        );
        assert_eq!(posix::resolve_path("/home/sandbox", "/tmp"), "/tmp");
        assert_eq!(
            posix::resolve_path("/home/sandbox", "/tmp/workdir"),
            "/tmp/workdir"
        );
    }

    #[test]
    fn normalizes_parent_segments_in_relative_paths() {
        assert_eq!(
            posix::resolve_path("/home/sandbox", "../../etc/passwd"),
            "/etc/passwd"
        );
        assert_eq!(posix::resolve_path("work", "a/../../b"), "b");
    }

    #[test]
    fn collapses_double_slashes_in_absolute_paths() {
        assert_eq!(
            posix::resolve_path("/home/sandbox", "//etc/passwd"),
            "/etc/passwd"
        );
    }

    #[test]
    fn accepts_paths_under_the_workspace() {
        assert!(posix::is_inside_workspace(
            "/home/sandbox/file.txt",
            "/home/sandbox"
        ));
        assert!(posix::is_inside_workspace("/home/sandbox", "/home/sandbox"));
    }

    #[test]
    fn rejects_paths_outside_the_workspace() {
        assert!(!posix::is_inside_workspace("/etc/passwd", "/home/sandbox"));
        // Prefix-match must not cross the directory boundary.
        assert!(!posix::is_inside_workspace(
            "/home/sandboxer",
            "/home/sandbox"
        ));
    }

    #[test]
    fn rejects_parent_traversal_through_the_workspace_root() {
        assert!(!posix::is_inside_workspace(
            "/home/sandbox/../../etc/passwd",
            "/home/sandbox"
        ));
    }

    #[test]
    fn resolves_a_windows_path_against_a_drive_workspace() {
        let ws = r"C:\work";
        assert_eq!(
            win32::resolve_path(ws, r"src\main.rs"),
            r"C:\work\src\main.rs"
        );
        assert_eq!(
            win32::resolve_path(ws, "src/main.rs"),
            r"C:\work\src\main.rs"
        );
        assert_eq!(
            win32::resolve_path(r"C:\work\", r".\a\.\b\"),
            r"C:\work\a\b"
        );
        assert_eq!(win32::resolve_path(ws, ""), r"C:\work");
        assert_eq!(win32::resolve_path(ws, r"D:rel\x"), r"C:\work\D:rel\x");
        assert_eq!(win32::resolve_path("work", r"a\..\..\b"), "b");
    }

    #[test]
    fn keeps_a_windows_absolute_path_and_stops_dot_dot_at_its_root() {
        let ws = r"C:\work";
        assert_eq!(win32::resolve_path(ws, r"C:\other\x"), r"C:\other\x");
        assert_eq!(win32::resolve_path(ws, "C:/other/x"), r"C:\other\x");
        assert_eq!(win32::resolve_path(ws, r"\tmp\x"), r"\tmp\x");
        assert_eq!(win32::resolve_path(ws, "/tmp/x"), r"\tmp\x");
        assert_eq!(win32::resolve_path(ws, r"..\..\etc"), r"C:\etc");
        assert_eq!(win32::resolve_path(ws, r"..\.."), r"C:\");
        assert_eq!(
            win32::resolve_path(r"\\server\share\ws", r"a\..\..\..\b"),
            r"\\server\share\b"
        );
    }

    #[test]
    fn contains_a_windows_path_by_its_segments() {
        let ws = r"C:\work";
        assert!(win32::is_inside_workspace(r"C:\work\a", ws));
        assert!(win32::is_inside_workspace(r"c:\WORK\a", ws));
        assert!(win32::is_inside_workspace(r"C:\work", ws));
        assert!(win32::is_inside_workspace(r"C:\x", r"C:\"));
        assert!(!win32::is_inside_workspace(r"C:\workshop", ws));
        assert!(!win32::is_inside_workspace(r"C:\other", ws));
        assert!(!win32::is_inside_workspace(r"C:\work\..\other", ws));
        assert!(!win32::is_inside_workspace(r"D:\work\a", ws));
    }
}
