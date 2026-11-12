//! Reads the identity documents a deployment gives a new agent, from the
//! directory `PRISM_WORKSPACE_SEED_DIR` names: one `<field>.md` per document,
//! such as `soulMd.md` or `agentMd.md`. A document the directory holds replaces
//! the default template when the runtime first creates its agent
//! (`resolve_or_bootstrap_single_agent`); a document it lacks keeps the default.
//!
//! Only that first boot reads the directory. A platform that writes the files
//! on every start (Lens Agents start files) therefore overwrites nothing the
//! agent or its user changed later.
//!
//! `memoryMd` is not seedable: memory is what the agent learns, not a document a
//! deployment writes. A file that cannot be read keeps the default for its
//! field: a bad seed never stops the agent from booting.

use crate::lib::workspace_docs::{WORKSPACE_DOC_FIELDS, WorkspaceDocField};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::path::Path;

/// The seeded documents, each present only when the seed directory holds it.
/// Serializes as the TypeScript `Partial<Record<SeedableField, string>>`: only the
/// fields it holds, in [`WORKSPACE_DOC_FIELDS`] order.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSeed {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_md: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub soul_md: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_md: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub heartbeat_md: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vision_md: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bootstrap_md: Option<String>,
}

impl WorkspaceSeed {
    /// The seeded text of one document; `None` for `memoryMd`, which is not seedable.
    pub fn get(&self, field: WorkspaceDocField) -> Option<&str> {
        self.slot(field).and_then(|slot| slot.as_deref())
    }

    /// Sets one document. A `memoryMd` value is dropped, since it is not seedable.
    pub fn set(&mut self, field: WorkspaceDocField, text: String) {
        if let Some(slot) = self.slot_mut(field) {
            *slot = Some(text);
        }
    }

    /// The fields the seed holds, in [`WORKSPACE_DOC_FIELDS`] order (`Object.keys`).
    pub fn fields(&self) -> Vec<WorkspaceDocField> {
        WORKSPACE_DOC_FIELDS
            .into_iter()
            .filter(|field| self.get(*field).is_some())
            .collect()
    }

    fn slot(&self, field: WorkspaceDocField) -> Option<&Option<String>> {
        match field {
            WorkspaceDocField::AgentMd => Some(&self.agent_md),
            WorkspaceDocField::SoulMd => Some(&self.soul_md),
            WorkspaceDocField::UserMd => Some(&self.user_md),
            WorkspaceDocField::HeartbeatMd => Some(&self.heartbeat_md),
            WorkspaceDocField::MemoryMd => None,
            WorkspaceDocField::VisionMd => Some(&self.vision_md),
            WorkspaceDocField::BootstrapMd => Some(&self.bootstrap_md),
        }
    }

    fn slot_mut(&mut self, field: WorkspaceDocField) -> Option<&mut Option<String>> {
        match field {
            WorkspaceDocField::AgentMd => Some(&mut self.agent_md),
            WorkspaceDocField::SoulMd => Some(&mut self.soul_md),
            WorkspaceDocField::UserMd => Some(&mut self.user_md),
            WorkspaceDocField::HeartbeatMd => Some(&mut self.heartbeat_md),
            WorkspaceDocField::MemoryMd => None,
            WorkspaceDocField::VisionMd => Some(&mut self.vision_md),
            WorkspaceDocField::BootstrapMd => Some(&mut self.bootstrap_md),
        }
    }
}

/// Every document field but `memoryMd`, in [`WORKSPACE_DOC_FIELDS`] order.
fn seedable_fields() -> impl Iterator<Item = WorkspaceDocField> {
    WORKSPACE_DOC_FIELDS
        .into_iter()
        .filter(|field| *field != WorkspaceDocField::MemoryMd)
}

/// Reads the seed directory. An unset or empty `dir` seeds nothing.
pub fn read_workspace_seed(dir: Option<&str>) -> WorkspaceSeed {
    let Some(dir) = dir.filter(|dir| !dir.is_empty()) else {
        return WorkspaceSeed::default();
    };

    let mut seed = WorkspaceSeed::default();
    for field in seedable_fields() {
        let file = Path::new(dir).join(format!("{}.md", field.as_str()));
        // `readFileSync(file, 'utf8')`: an invalid sequence reads as U+FFFD.
        match std::fs::read(&file) {
            Ok(bytes) => seed.set(field, String::from_utf8_lossy(&bytes).into_owned()),
            Err(err) => {
                // A missing document is the ordinary case: the seed names only the ones it changes.
                if err.kind() != std::io::ErrorKind::NotFound {
                    let file = file.to_string_lossy().into_owned();
                    crate::log_warn!(
                        json!({ "err": crate::lib::log_redaction::err_json(&anyhow::Error::from(err)), "file": file }),
                        "[WorkspaceSeed] cannot read a seeded document; keeping the default"
                    );
                }
            }
        }
    }
    seed
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &tempfile::TempDir, name: &str, content: &str) {
        std::fs::write(dir.path().join(name), content).unwrap();
    }

    fn read(dir: &tempfile::TempDir) -> WorkspaceSeed {
        read_workspace_seed(Some(dir.path().to_str().unwrap()))
    }

    #[test]
    fn reads_one_document_per_field_file() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "soulMd.md", "# Soul\n\nYou are {{agentName}}.");
        write(&dir, "agentMd.md", "# Guide");
        write(&dir, "bootstrapMd.md", "# Bootstrap");

        assert_eq!(
            read(&dir),
            WorkspaceSeed {
                soul_md: Some("# Soul\n\nYou are {{agentName}}.".into()),
                agent_md: Some("# Guide".into()),
                bootstrap_md: Some("# Bootstrap".into()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn keeps_an_empty_file_which_clears_that_document() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "bootstrapMd.md", "");
        assert_eq!(
            read(&dir),
            WorkspaceSeed {
                bootstrap_md: Some(String::new()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn does_not_seed_memory() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "memoryMd.md", "# Memory");
        assert_eq!(read(&dir), WorkspaceSeed::default());
    }

    #[test]
    fn ignores_files_that_name_no_document() {
        let dir = tempfile::tempdir().unwrap();
        write(&dir, "notes.md", "hello");
        write(&dir, "soulMd.txt", "hello");
        assert_eq!(read(&dir), WorkspaceSeed::default());
    }

    #[test]
    fn keeps_the_default_for_a_document_it_cannot_read() {
        let dir = tempfile::tempdir().unwrap();
        // A directory where the file should be fails the read.
        std::fs::create_dir(dir.path().join("agentMd.md")).unwrap();
        write(&dir, "soulMd.md", "# Soul");
        assert_eq!(
            read(&dir),
            WorkspaceSeed {
                soul_md: Some("# Soul".into()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn returns_nothing_for_a_directory_that_does_not_exist() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(
            read_workspace_seed(Some(missing.to_str().unwrap())),
            WorkspaceSeed::default()
        );
    }

    #[test]
    fn returns_nothing_when_no_directory_is_configured() {
        assert_eq!(read_workspace_seed(None), WorkspaceSeed::default());
        assert_eq!(read_workspace_seed(Some("")), WorkspaceSeed::default());
    }

    #[test]
    fn reads_the_documents_the_directory_holds_and_skips_memory() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("soulMd.md"), "soul").unwrap();
        std::fs::write(dir.path().join("memoryMd.md"), "memory").unwrap();
        let seed = read_workspace_seed(Some(dir.path().to_str().unwrap()));
        assert_eq!(seed.get(WorkspaceDocField::SoulMd), Some("soul"));
        assert_eq!(seed.fields(), vec![WorkspaceDocField::SoulMd]);
        assert_eq!(
            serde_json::to_string(&seed).unwrap(),
            r#"{"soulMd":"soul"}"#
        );
        assert_eq!(read_workspace_seed(None), WorkspaceSeed::default());
    }
}
