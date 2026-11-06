//! What the exec container stores, and where.
//!
//! Every durable path is a **named volume** the engine owns, mounted at a fixed
//! path under `/prism`. Two things follow from that, and they are the whole
//! design.
//!
//! The paths are the container's own rather than this machine's, because a
//! named volume has no path on this machine to agree with — on macOS and
//! Windows it is not even on this machine, it is inside the engine's virtual
//! one. Fixing them also lets the image create each directory, which is what
//! makes a fresh volume writable by a container running as the runtime's user:
//! the engine seeds a new volume from the image's directory, mode and all.
//!
//! The volumes outlive the container. `shutdown` removes the container and
//! nothing else, so the workspace, the skills, the plugins and both coding
//! agents' logins are still there for the next boot, and for a `docker cp`.

/// The container's root for everything the agent works with.
pub const PRISM_ROOT: &str = "/prism";

pub struct ContainerPaths {
    pub workspace_root: &'static str,
    pub skills_dir: &'static str,
    pub plugins_dir: &'static str,
    pub plugin_data_dir: &'static str,
    pub tool_output_dir: &'static str,
    pub claude_home: &'static str,
    pub codex_home: &'static str,
    /// `$HOME`. A package cache and a `gh auth login` land here, so it is kept
    /// like the rest — and outside the workspace, so dotfiles stay out of the
    /// user's repository.
    pub home_dir: &'static str,
}

pub const CONTAINER_PATHS: ContainerPaths = ContainerPaths {
    workspace_root: "/prism/workspace",
    skills_dir: "/prism/skills",
    plugins_dir: "/prism/plugins",
    plugin_data_dir: "/prism/plugin-data",
    tool_output_dir: "/prism/tool-outputs",
    claude_home: "/prism/claude",
    codex_home: "/prism/codex",
    home_dir: "/prism/home",
};

/// The key of each `CONTAINER_PATHS` entry, in its order.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum VolumePurpose {
    WorkspaceRoot,
    SkillsDir,
    PluginsDir,
    PluginDataDir,
    ToolOutputDir,
    ClaudeHome,
    CodexHome,
    HomeDir,
}

impl VolumePurpose {
    /// The key as `CONTAINER_PATHS` names it (`workspaceRoot`, `skillsDir`, …).
    pub fn as_str(self) -> &'static str {
        match self {
            VolumePurpose::WorkspaceRoot => "workspaceRoot",
            VolumePurpose::SkillsDir => "skillsDir",
            VolumePurpose::PluginsDir => "pluginsDir",
            VolumePurpose::PluginDataDir => "pluginDataDir",
            VolumePurpose::ToolOutputDir => "toolOutputDir",
            VolumePurpose::ClaudeHome => "claudeHome",
            VolumePurpose::CodexHome => "codexHome",
            VolumePurpose::HomeDir => "homeDir",
        }
    }

    pub fn path(self) -> &'static str {
        match self {
            VolumePurpose::WorkspaceRoot => CONTAINER_PATHS.workspace_root,
            VolumePurpose::SkillsDir => CONTAINER_PATHS.skills_dir,
            VolumePurpose::PluginsDir => CONTAINER_PATHS.plugins_dir,
            VolumePurpose::PluginDataDir => CONTAINER_PATHS.plugin_data_dir,
            VolumePurpose::ToolOutputDir => CONTAINER_PATHS.tool_output_dir,
            VolumePurpose::ClaudeHome => CONTAINER_PATHS.claude_home,
            VolumePurpose::CodexHome => CONTAINER_PATHS.codex_home,
            VolumePurpose::HomeDir => CONTAINER_PATHS.home_dir,
        }
    }
}

/// The volume behind each path, named for the deployment so two runtimes on one
/// host never share one. The digest is the same one the container is named
/// after, so `docker volume ls` groups them beside it.
pub fn volume_name(deployment: &str, purpose: VolumePurpose) -> String {
    format!("prism-exec-{deployment}-{}", kebab(purpose.as_str()))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeMount {
    pub name: String,
    pub path: String,
}

/// Every `--volume name:path` pair the container is created with.
pub fn volume_mounts(deployment: &str) -> Vec<VolumeMount> {
    purposes()
        .into_iter()
        .map(|purpose| VolumeMount {
            name: volume_name(deployment, purpose),
            path: purpose.path().to_string(),
        })
        .collect()
}

pub fn purposes() -> Vec<VolumePurpose> {
    vec![
        VolumePurpose::WorkspaceRoot,
        VolumePurpose::SkillsDir,
        VolumePurpose::PluginsDir,
        VolumePurpose::PluginDataDir,
        VolumePurpose::ToolOutputDir,
        VolumePurpose::ClaudeHome,
        VolumePurpose::CodexHome,
        VolumePurpose::HomeDir,
    ]
}

/// Whether a command with this cwd can run here.
///
/// Only the container's own tree, so a thread rooted in a repository on this
/// machine answers false and runs locally — the same rule as before, against a
/// namespace that is now the container's.
pub fn serves_path(candidate: &str) -> bool {
    if !candidate.starts_with('/') {
        return false;
    }
    let normalized = normalize(candidate);
    normalized == PRISM_ROOT || normalized.starts_with(&format!("{PRISM_ROOT}/"))
}

/// Resolve `.` and `..` without touching this machine's filesystem: a container
/// path is POSIX whatever the host is, and a relative one is rejected above.
fn normalize(candidate: &str) -> String {
    let mut out: Vec<&str> = Vec::new();
    for part in candidate.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    format!("/{}", out.join("/"))
}

/// `camelCase` to `kebab-case`: a hyphen between a lowercase letter and the
/// uppercase one after it.
fn kebab(purpose: &str) -> String {
    let mut out = String::with_capacity(purpose.len() + 4);
    let mut previous_lower = false;
    for ch in purpose.chars() {
        if ch.is_ascii_uppercase() && previous_lower {
            out.push('-');
        }
        previous_lower = ch.is_ascii_lowercase();
        out.push(ch.to_ascii_lowercase());
    }
    out
}
