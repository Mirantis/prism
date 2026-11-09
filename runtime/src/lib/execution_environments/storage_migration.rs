//! Moving the agent's files when the deployment changes where commands run.
//!
//! The two environments keep the agent's storage in different places: one uses
//! directories on this machine, the other named volumes the engine owns.
//! Installing a container engine, or setting `EXECUTION_ENVIRONMENT`, therefore
//! moves the agent to storage that starts out empty — its skills, its plugins,
//! its workspace and both coding-agent logins would appear to be gone, with the
//! originals sitting untouched on the side it came from.
//!
//! So a boot that finds the environment changed copies the agent's files across
//! first. The database is not involved: it is the runtime's own and stays on
//! this machine under either environment, which is why memory, threads and the
//! identity documents survive the switch on their own.
//!
//! **Nothing is overwritten.** Only an entry the destination does not already
//! have is copied, so switching back and forth merges rather than clobbers: work
//! done on one side arrives on the other, and work already there is left alone.
//! The cost is that an entry edited on both sides keeps the destination's copy,
//! which is the safe way round — the other one is still where it was.

use std::collections::HashSet;
use std::sync::Arc;

use async_trait::async_trait;
use indexmap::IndexMap;
use serde::Serialize;
use serde_json::json;

use super::docker::docker_copy::{copy_from_container, copy_into_container, open_volumes};
use super::docker::docker_environment::{
    create_docker_environment, deployment_id, exec_container_name,
};
use super::docker::docker_files::create_docker_files;
use super::execution_environment::{
    ExecutionEnvironment, ExecutionEnvironmentName, ExecutionFiles, ProcessEnv, io_error_kind,
};
use super::get_execution_environment::get_execution_environment;
use super::local::local_environment::create_local_environment;
use crate::config::CONFIG;
use crate::lib::coding_agents::claude_code::home::resolve_claude_config_dir;
use crate::lib::coding_agents::codex::credentials::resolve_codex_home;
use crate::lib::log_redaction::err_json;
use crate::lib::telemetry::track_event;
use crate::services::runtime_state_service::{LAST_EXECUTION_ENVIRONMENT, RUNTIME_STATE_SERVICE};
use crate::{log_error, log_info, log_warn};

/// What moves. The saved tool outputs and the container's `$HOME` are left out:
/// both are caches with their own expiry, and copying them would move stale
/// bytes the agent never asked for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Migrated {
    Workspace,
    Skills,
    Plugins,
    PluginData,
    ClaudeHome,
    CodexHome,
}

impl Migrated {
    pub fn as_str(self) -> &'static str {
        match self {
            Migrated::Workspace => "workspace",
            Migrated::Skills => "skills",
            Migrated::Plugins => "plugins",
            Migrated::PluginData => "plugin data",
            Migrated::ClaudeHome => "claude home",
            Migrated::CodexHome => "codex home",
        }
    }
}

pub const MIGRATED: [Migrated; 6] = [
    Migrated::Workspace,
    Migrated::Skills,
    Migrated::Plugins,
    Migrated::PluginData,
    Migrated::ClaudeHome,
    Migrated::CodexHome,
];

/// Logged as the fields of `[Startup] moved the agent's files`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct MigrationReport {
    pub from: ExecutionEnvironmentName,
    pub to: ExecutionEnvironmentName,
    pub copied: i64,
    pub skipped: i64,
    pub failures: i64,
}

/// Record the environment this run uses, and move the agent's files first when
/// the last run used the other one.
///
/// Never fails: a failed entry is removed from the target, so both sides are as
/// they were for it, and an agent that boots without its skills is better than
/// one that does not boot. The stored environment advances only once every entry
/// has landed, so the next boot tries the rest again.
pub async fn migrate_storage_if_environment_changed() -> Option<MigrationReport> {
    let current = get_execution_environment().id();
    let stored = RUNTIME_STATE_SERVICE
        .get(LAST_EXECUTION_ENVIRONMENT)
        .await
        .unwrap_or(None);
    // No record is an install from before the record existed, and every such
    // install ran locally. A fresh install reads the same way and moves nothing,
    // because its host directories are empty.
    let previous = stored
        .as_deref()
        .and_then(ExecutionEnvironmentName::parse)
        .unwrap_or(ExecutionEnvironmentName::Local);

    if previous == current {
        if stored.is_none() {
            remember(current).await;
        }
        return None;
    }

    log_info!(
        json!({ "from": previous, "to": current }),
        "[Startup] the execution environment changed; moving the agent's files"
    );

    let report = match migrate(previous, current).await {
        Ok(report) => report,
        Err(err) => {
            log_error!(
                json!({ "err": err_json(&err), "from": previous, "to": current }),
                "[Startup] could not move the files"
            );
            track_event(
                "exec storage migrated",
                Some(&CONFIG.owner_user_id()),
                Some(IndexMap::from([
                    ("migration.from".to_string(), previous.as_str().to_string()),
                    ("migration.to".to_string(), current.as_str().to_string()),
                    ("status".to_string(), "failed".to_string()),
                ])),
            );
            return None;
        }
    };

    // An entry that failed was removed from the target, so the next boot finds
    // it missing there and copies it again. Recording the new environment now
    // would stop that retry for good.
    if report.failures == 0 {
        remember(current).await;
    }
    log_info!(
        serde_json::to_value(&report).unwrap_or_default(),
        "[Startup] moved the agent's files"
    );
    let status = if report.failures > 0 { "partial" } else { "ok" };
    track_event(
        "exec storage migrated",
        Some(&CONFIG.owner_user_id()),
        Some(IndexMap::from([
            (
                "migration.from".to_string(),
                report.from.as_str().to_string(),
            ),
            ("migration.to".to_string(), report.to.as_str().to_string()),
            ("status".to_string(), status.to_string()),
            ("copied".to_string(), report.copied.to_string()),
            ("skipped".to_string(), report.skipped.to_string()),
        ])),
    );
    Some(report)
}

/// Store the environment in `runtime_state`; a failure is logged
/// (`[Startup] could not record the execution environment`) and not fatal.
async fn remember(current: ExecutionEnvironmentName) {
    if let Err(err) = RUNTIME_STATE_SERVICE
        .set(LAST_EXECUTION_ENVIRONMENT, current.as_str())
        .await
    {
        // The next boot would then try the same migration again, which is safe —
        // nothing is overwritten — so this is reported and not fatal.
        log_warn!(
            json!({ "err": err_json(&err) }),
            "[Startup] could not record the execution environment"
        );
    }
}

async fn migrate(
    previous: ExecutionEnvironmentName,
    current: ExecutionEnvironmentName,
) -> anyhow::Result<MigrationReport> {
    let deployment = deployment_id();
    let local = create_local_environment();
    let docker = create_docker_environment();
    let access = open_volumes(&deployment, &exec_container_name(&deployment)).await?;
    let container_files = create_docker_files(&access.container);

    let moved = move_all(
        previous,
        current,
        &access.container,
        Storage {
            files: local.files(),
            dir: Box::new(move |what| directory_of(local.as_ref(), what)),
        },
        Storage {
            files: container_files,
            dir: Box::new(move |what| directory_of(docker.as_ref(), what)),
        },
        &DockerCopier,
    )
    .await;

    if let Err(err) = access.release().await {
        log_warn!(
            json!({ "err": err_json(&err) }),
            "[Docker] could not remove the copy container"
        );
    }
    moved
}

/// One environment's storage: its files, and where each kind lives in it.
struct Storage {
    files: Arc<dyn ExecutionFiles>,
    dir: Box<dyn Fn(Migrated) -> String + Send + Sync>,
}

/// How one entry crosses into or out of the container.
#[async_trait]
trait EntryCopier: Send + Sync {
    async fn copy_into(&self, container: &str, from: &str, to: &str) -> anyhow::Result<()>;
    async fn copy_from(&self, container: &str, from: &str, to: &str) -> anyhow::Result<()>;
}

struct DockerCopier;

#[async_trait]
impl EntryCopier for DockerCopier {
    async fn copy_into(&self, container: &str, from: &str, to: &str) -> anyhow::Result<()> {
        copy_into_container(container, from, to).await
    }

    async fn copy_from(&self, container: &str, from: &str, to: &str) -> anyhow::Result<()> {
        copy_from_container(container, from, to).await
    }
}

/// Every kind, in order, from the side the last run used to this run's side.
async fn move_all(
    previous: ExecutionEnvironmentName,
    current: ExecutionEnvironmentName,
    container: &str,
    host: Storage,
    inside: Storage,
    copier: &dyn EntryCopier,
) -> anyhow::Result<MigrationReport> {
    let mut report = MigrationReport {
        from: previous,
        to: current,
        copied: 0,
        skipped: 0,
        failures: 0,
    };
    let into_container = current == ExecutionEnvironmentName::Docker;
    for what in MIGRATED {
        let host_side = Side {
            path: (host.dir)(what),
            files: host.files.clone(),
        };
        let container_side = Side {
            path: (inside.dir)(what),
            files: inside.files.clone(),
        };
        let (source, target) = if into_container {
            (host_side, container_side)
        } else {
            (container_side, host_side)
        };
        move_entries(
            what,
            into_container,
            container,
            source,
            target,
            &mut report,
            copier,
        )
        .await?;
    }
    Ok(report)
}

/// One side of a copy, over whichever filesystem holds it.
struct Side {
    path: String,
    files: Arc<dyn ExecutionFiles>,
}

/// Copy every entry of `source` the target lacks, counting it in `report`, and
/// remove a partial copy when one fails. Fails only when the destination
/// directory cannot be created.
async fn move_entries(
    what: Migrated,
    into_container: bool,
    container: &str,
    source: Side,
    target: Side,
    report: &mut MigrationReport,
    copier: &dyn EntryCopier,
) -> anyhow::Result<()> {
    let entries = match source.files.read_dir(&source.path).await {
        Ok(entries) if !entries.is_empty() => entries,
        // Nothing there to move.
        _ => return Ok(()),
    };

    // Only a missing target is empty. Any other failure leaves what it holds
    // unknown, and copying over it would nest entries inside existing ones.
    let listed = match target.files.read_dir(&target.path).await {
        Ok(listed) => listed,
        Err(err) if io_error_kind(&err) == Some(std::io::ErrorKind::NotFound) => Vec::new(),
        Err(err) => {
            report.failures += 1;
            log_warn!(
                json!({ "err": err_json(&err), "what": what.as_str() }),
                "[Startup] could not list the destination"
            );
            return Ok(());
        }
    };
    let held: HashSet<String> = listed.into_iter().map(|entry| entry.name).collect();
    // The destination may not exist yet: `docker cp` will not create a parent.
    target.files.mkdir(&target.path).await?;

    for entry in entries {
        if held.contains(&entry.name) {
            report.skipped += 1;
            continue;
        }
        let from = format!("{}/{}", source.path, entry.name);
        let to = format!("{}/{}", target.path, entry.name);
        // Logged before the copy: a large workspace entry can hold up boot for as
        // long as the copy timeout, and this line names what it is waiting on.
        log_info!(
            json!({ "what": what.as_str(), "entry": entry.name }),
            "[Startup] moving"
        );
        let copied = if into_container {
            copier.copy_into(container, &from, &to).await
        } else {
            copier.copy_from(container, &from, &to).await
        };
        match copied {
            Ok(()) => report.copied += 1,
            Err(err) => {
                report.failures += 1;
                log_warn!(
                    json!({ "err": err_json(&err), "what": what.as_str(), "entry": entry.name }),
                    "[Startup] could not move this one"
                );
                // The target lacked this entry before the copy started, so whatever
                // is there now is the partial copy and nothing else.
                if let Err(remove_err) = target.files.remove(&to).await {
                    log_warn!(
                        json!({ "err": err_json(&remove_err), "what": what.as_str(), "entry": entry.name }),
                        "[Startup] could not remove a partial copy"
                    );
                }
            }
        }
    }
    Ok(())
}

/// The directory each kind lives in, for one environment.
///
/// On this machine a coding agent's home is always the runtime's own one under
/// the data dir. An operator's `CLAUDE_CONFIG_DIR` or `CODEX_HOME` usually names
/// their real `~/.claude` or `~/.codex`, and copying that into the agent's volume
/// would hand the agent's shell the operator's sessions and credentials.
fn directory_of(environment: &dyn ExecutionEnvironment, what: Migrated) -> String {
    let paths = environment.paths();
    let on_host = environment.id() == ExecutionEnvironmentName::Local;
    match what {
        Migrated::Workspace => environment.workspace_root(),
        Migrated::Skills => paths.skills_dir,
        Migrated::Plugins => paths.plugins_dir,
        Migrated::PluginData => paths.plugin_data_dir,
        Migrated::ClaudeHome if on_host => resolve_claude_config_dir(&ProcessEnv::new(), None),
        Migrated::ClaudeHome => paths.claude_home,
        Migrated::CodexHome if on_host => resolve_codex_home(&ProcessEnv::new(), None),
        Migrated::CodexHome => paths.codex_home,
    }
}

#[cfg(test)]
mod tests {
    //! Moving the agent's files between the two sides. The engine is never run:
    //! the copies are recorded, and each side is a map of directory to entry
    //! names, so these cases say the same thing with or without an engine.

    use std::collections::HashMap;

    use parking_lot::Mutex;

    use super::*;
    use crate::lib::execution_environments::execution_environment::{DirEntry, FileStat};

    /// A directory whose listing fails for a reason other than being absent.
    const UNREADABLE: &str = "<unreadable>";

    #[derive(Default)]
    struct FakeFiles {
        dirs: Mutex<HashMap<String, Vec<String>>>,
        removed: Arc<Mutex<Vec<String>>>,
    }

    impl FakeFiles {
        fn with(dirs: &[(&str, &[&str])], removed: Arc<Mutex<Vec<String>>>) -> Arc<Self> {
            Arc::new(FakeFiles {
                dirs: Mutex::new(
                    dirs.iter()
                        .map(|(dir, names)| {
                            (
                                dir.to_string(),
                                names.iter().map(|n| n.to_string()).collect(),
                            )
                        })
                        .collect(),
                ),
                removed,
            })
        }
    }

    #[async_trait]
    impl ExecutionFiles for FakeFiles {
        async fn read_dir(&self, path: &str) -> anyhow::Result<Vec<DirEntry>> {
            let names = self.dirs.lock().get(path).cloned();
            let Some(names) = names else {
                return Err(anyhow::Error::new(std::io::Error::new(
                    std::io::ErrorKind::NotFound,
                    "missing",
                )));
            };
            if names.first().map(String::as_str) == Some(UNREADABLE) {
                anyhow::bail!("docker exec timed out");
            }
            Ok(names
                .into_iter()
                .map(|name| DirEntry {
                    name,
                    is_file: true,
                    is_directory: false,
                    is_symbolic_link: false,
                })
                .collect())
        }

        async fn mkdir(&self, path: &str) -> anyhow::Result<()> {
            self.dirs.lock().entry(path.to_string()).or_default();
            Ok(())
        }

        async fn remove(&self, path: &str) -> anyhow::Result<()> {
            self.removed.lock().push(path.to_string());
            Ok(())
        }

        async fn read_text(&self, _: &str, _: Option<usize>) -> anyhow::Result<String> {
            anyhow::bail!("not used by the migration")
        }
        async fn read_bytes(&self, _: &str) -> anyhow::Result<Vec<u8>> {
            anyhow::bail!("not used by the migration")
        }
        async fn write_text(&self, _: &str, _: &str, _: Option<u32>) -> anyhow::Result<()> {
            anyhow::bail!("not used by the migration")
        }
        async fn write_bytes(&self, _: &str, _: &[u8]) -> anyhow::Result<()> {
            anyhow::bail!("not used by the migration")
        }
        async fn make_temp_dir(&self, _: &str) -> anyhow::Result<String> {
            anyhow::bail!("not used by the migration")
        }
        async fn rename(&self, _: &str, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("not used by the migration")
        }
        async fn stat(&self, _: &str) -> anyhow::Result<FileStat> {
            anyhow::bail!("not used by the migration")
        }
        async fn lstat(&self, _: &str) -> anyhow::Result<FileStat> {
            anyhow::bail!("not used by the migration")
        }
        async fn remove_dir(&self, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("not used by the migration")
        }
        async fn symlink(&self, _: &str, _: &str) -> anyhow::Result<()> {
            anyhow::bail!("not used by the migration")
        }
        async fn realpath(&self, _: &str) -> anyhow::Result<String> {
            anyhow::bail!("not used by the migration")
        }
    }

    #[derive(Default)]
    struct FakeCopier {
        copies: Mutex<Vec<(&'static str, String, String)>>,
        fails: Option<&'static str>,
    }

    #[async_trait]
    impl EntryCopier for FakeCopier {
        async fn copy_into(&self, _: &str, from: &str, to: &str) -> anyhow::Result<()> {
            if self.fails.is_some_and(|name| from.contains(name)) {
                anyhow::bail!("copy failed");
            }
            self.copies.lock().push(("in", from.into(), to.into()));
            Ok(())
        }

        async fn copy_from(&self, _: &str, from: &str, to: &str) -> anyhow::Result<()> {
            if self.fails.is_some_and(|name| from.contains(name)) {
                anyhow::bail!("copy failed");
            }
            self.copies.lock().push(("out", from.into(), to.into()));
            Ok(())
        }
    }

    /// The host side as the local environment lays it out, with the runtime's
    /// own coding-agent homes under the data dir.
    fn host_dir(what: Migrated) -> String {
        match what {
            Migrated::Workspace => "/host/workspace",
            Migrated::Skills => "/host/skills",
            Migrated::Plugins => "/host/plugins",
            Migrated::PluginData => "/host/plugin-data",
            Migrated::ClaudeHome => "/host/data/.claude",
            Migrated::CodexHome => "/host/data/.codex",
        }
        .to_string()
    }

    fn container_dir(what: Migrated) -> String {
        match what {
            Migrated::Workspace => "/prism/workspace",
            Migrated::Skills => "/prism/skills",
            Migrated::Plugins => "/prism/plugins",
            Migrated::PluginData => "/prism/plugin-data",
            Migrated::ClaudeHome => "/prism/claude",
            Migrated::CodexHome => "/prism/codex",
        }
        .to_string()
    }

    struct Run {
        report: anyhow::Result<MigrationReport>,
        copies: Vec<(&'static str, String, String)>,
        removed: Vec<String>,
    }

    async fn run(
        current: ExecutionEnvironmentName,
        host: &[(&str, &[&str])],
        inside: &[(&str, &[&str])],
        fails: Option<&'static str>,
    ) -> Run {
        let removed = Arc::new(Mutex::new(Vec::new()));
        let previous = match current {
            ExecutionEnvironmentName::Docker => ExecutionEnvironmentName::Local,
            ExecutionEnvironmentName::Local => ExecutionEnvironmentName::Docker,
        };
        let copier = FakeCopier {
            copies: Mutex::new(Vec::new()),
            fails,
        };
        let report = move_all(
            previous,
            current,
            "prism-agent-exec-test",
            Storage {
                files: FakeFiles::with(host, removed.clone()),
                dir: Box::new(host_dir),
            },
            Storage {
                files: FakeFiles::with(inside, removed.clone()),
                dir: Box::new(container_dir),
            },
            &copier,
        )
        .await;
        let copies = copier.copies.lock().clone();
        let removed = removed.lock().clone();
        Run {
            report,
            copies,
            removed,
        }
    }

    fn targets(copies: &[(&'static str, String, String)]) -> Vec<String> {
        copies.iter().map(|(_, _, to)| to.clone()).collect()
    }

    fn sources(copies: &[(&'static str, String, String)]) -> Vec<String> {
        copies.iter().map(|(_, from, _)| from.clone()).collect()
    }

    use ExecutionEnvironmentName::{Docker, Local};

    #[tokio::test]
    async fn copies_what_the_container_does_not_have() {
        let run = run(
            Docker,
            &[
                ("/host/skills", &["kept-skill"]),
                ("/host/workspace", &["report.md"]),
            ],
            &[("/prism/skills", &[]), ("/prism/workspace", &[])],
            None,
        )
        .await;
        let report = run.report.unwrap();
        assert_eq!((report.from, report.to), (Local, Docker));
        assert_eq!((report.copied, report.failures), (2, 0));
        assert_eq!(
            run.copies,
            vec![
                (
                    "in",
                    "/host/workspace/report.md".into(),
                    "/prism/workspace/report.md".into()
                ),
                (
                    "in",
                    "/host/skills/kept-skill".into(),
                    "/prism/skills/kept-skill".into()
                ),
            ]
        );
    }

    #[tokio::test]
    async fn never_overwrites_an_entry_the_container_already_has() {
        let run = run(
            Docker,
            &[("/host/skills", &["shared", "only-here"])],
            &[("/prism/skills", &["shared"])],
            None,
        )
        .await;
        let report = run.report.unwrap();
        assert_eq!((report.copied, report.skipped), (1, 1));
        assert_eq!(sources(&run.copies), ["/host/skills/only-here"]);
    }

    #[tokio::test]
    async fn moves_a_plugins_data_with_it() {
        let run = run(Docker, &[("/host/plugin-data", &["weather"])], &[], None).await;
        assert_eq!(targets(&run.copies), ["/prism/plugin-data/weather"]);
    }

    #[tokio::test]
    async fn skips_a_directory_that_is_not_there_rather_than_failing() {
        // A deployment that never installed a plugin has no plugins dir at all.
        let run = run(Docker, &[("/host/skills", &["a-skill"])], &[], None).await;
        let report = run.report.unwrap();
        assert_eq!((report.copied, report.failures), (1, 0));
    }

    #[tokio::test]
    async fn copies_out_of_the_container() {
        let run = run(
            Local,
            &[("/host/skills", &[])],
            &[("/prism/skills", &["made-in-there"])],
            None,
        )
        .await;
        let report = run.report.unwrap();
        assert_eq!((report.from, report.to, report.copied), (Docker, Local, 1));
        assert_eq!(
            run.copies,
            vec![(
                "out",
                "/prism/skills/made-in-there".into(),
                "/host/skills/made-in-there".into()
            )]
        );
    }

    #[tokio::test]
    async fn merges_a_round_trip_rather_than_clobbering_either_side() {
        let run = run(
            Local,
            &[("/host/skills", &["from-before"])],
            &[("/prism/skills", &["from-before", "from-the-container"])],
            None,
        )
        .await;
        let report = run.report.unwrap();
        assert_eq!((report.copied, report.skipped), (1, 1));
        assert_eq!(targets(&run.copies), ["/host/skills/from-the-container"]);
    }

    #[tokio::test]
    async fn carries_on_with_the_rest_and_counts_the_failure() {
        let run = run(
            Docker,
            &[("/host/skills", &["good", "bad"])],
            &[],
            Some("bad"),
        )
        .await;
        let report = run.report.unwrap();
        assert_eq!((report.copied, report.failures), (1, 1));
        assert_eq!(sources(&run.copies), ["/host/skills/good"]);
    }

    #[tokio::test]
    async fn removes_the_partial_copy_so_it_cannot_hide_the_intact_source() {
        let run = run(Docker, &[("/host/skills", &["bad"])], &[], Some("bad")).await;
        // A copy that stopped part-way would otherwise sit at the target, and the
        // next attempt skips a name the target already has.
        assert_eq!(run.removed, ["/prism/skills/bad"]);
    }

    #[tokio::test]
    async fn copies_nothing_into_a_destination_it_could_not_list() {
        let run = run(
            Docker,
            &[("/host/skills", &["a-skill"])],
            &[("/prism/skills", &[UNREADABLE])],
            None,
        )
        .await;
        // Its entries are unknown, and a copy onto one that exists would nest in it.
        assert_eq!(run.report.unwrap().failures, 1);
        assert!(!sources(&run.copies).contains(&"/host/skills/a-skill".to_string()));
        assert!(run.removed.is_empty());
    }

    #[test]
    fn takes_the_runtimes_own_coding_agent_homes_on_this_machine() {
        // The operator's real ~/.claude holds their sessions and credentials.
        let local = create_local_environment();
        assert_eq!(
            directory_of(local.as_ref(), Migrated::ClaudeHome),
            resolve_claude_config_dir(&ProcessEnv::new(), None)
        );
        assert_eq!(
            directory_of(local.as_ref(), Migrated::CodexHome),
            resolve_codex_home(&ProcessEnv::new(), None)
        );
    }

    #[test]
    fn leaves_the_saved_tool_outputs_behind() {
        // They expire on their own, so they are not one of the migrated kinds.
        let local = create_local_environment();
        let tool_outputs = local.paths().tool_output_dir;
        assert!(
            MIGRATED
                .iter()
                .all(|what| directory_of(local.as_ref(), *what) != tool_outputs)
        );
    }
}
