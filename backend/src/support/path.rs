//! Node's `path.resolve(p)` for one argument, on the platform's own path rules.

/// An absolute path normalized, a relative one resolved against this process's
/// working directory first. On Windows that is `std::path::absolute`, which keeps a
/// drive or UNC path as it is (`C:\work`); elsewhere `.` and `..` are collapsed on
/// `/`, a `..` above the root staying at the root.
pub fn resolve(path: &str) -> String {
    #[cfg(windows)]
    {
        std::path::absolute(path)
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| path.to_string())
    }
    #[cfg(not(windows))]
    {
        if path.starts_with('/') {
            return normalize(path);
        }
        let cwd = std::env::current_dir()
            .map(|d| d.to_string_lossy().into_owned())
            .unwrap_or_default();
        normalize(&format!("{cwd}/{path}"))
    }
}

#[cfg(not(windows))]
fn normalize(path: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            other => parts.push(other),
        }
    }
    format!("/{}", parts.join("/"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(not(windows))]
    #[test]
    fn normalizes_an_absolute_path_and_resolves_a_relative_one_against_the_cwd() {
        assert_eq!(resolve("/work/./a/../b/"), "/work/b");
        assert_eq!(resolve("/../.."), "/");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(resolve("x/y"), format!("{}/x/y", cwd.display()));
    }

    #[cfg(windows)]
    #[test]
    fn keeps_a_drive_or_unc_path_and_resolves_a_relative_one_against_the_cwd() {
        assert_eq!(resolve(r"C:\work"), r"C:\work");
        assert_eq!(resolve(r"C:\work\.\a\..\b"), r"C:\work\b");
        assert_eq!(resolve(r"\\server\share\dir"), r"\\server\share\dir");
        let cwd = std::env::current_dir().unwrap();
        assert_eq!(resolve("x"), cwd.join("x").to_string_lossy());
    }
}
