//! Startup Telemetry
//!
//! Single owner of the `agent started` product event — one census per boot,
//! emitted from `index.rs` once the agent row is resolved and cron tasks are
//! registered. It answers fleet-level product questions the startup logs can't:
//! which LLM vendor/models deployments actually run, whether they route through
//! the gateway, which integrations are wired up, what host Prism Agent runs on,
//! and how much of the feature surface is configured.
//!
//! Only ids, flags, counts and model identifiers — never tokens, URLs, paths or
//! user content. `deployment.environment.name` / `service.version` are already
//! OTel *resource* attributes (see `telemetry.rs`), so they are not repeated as
//! properties; heartbeat interval/status are owned by `heartbeat started`.

use indexmap::IndexMap;
use serde_json::json;

use crate::config::{CONFIG, Config, LlmProviderName};
use crate::db::models::AgentWorkspace;
use crate::lib::environment::is_sea;
use crate::lib::execution_environments::get_execution_environment::get_execution_environment;
use crate::lib::model_catalog::model_catalog_state;
use crate::lib::telemetry::{is_telemetry_enabled, llm_routing_for, track_event};
use crate::log_warn;
use crate::services::agent_workspace_service::AGENT_WORKSPACE_SERVICE;
use crate::services::plugin_catalog_service::PLUGIN_CATALOG_SERVICE;
use crate::services::skill_catalog_service::SKILL_CATALOG_SERVICE;
use crate::services::update::apply::{node_arch, node_platform};

/// What the census counts beyond the agent row.
#[derive(Debug, Clone, Copy, Default)]
pub struct TrackAgentStartedOptions {
    pub cron_tasks: usize,
}

/// What the census reads besides the configuration and the agent row.
struct Census<'a> {
    agent_id: &'a str,
    webhooks_enabled: bool,
    locked_in: bool,
    cron_tasks: usize,
    skills: usize,
    plugins: usize,
    subagents: usize,
    model_catalog_state: &'static str,
    execution_environment: &'static str,
}

/// Emits `agent started` for the agent (its `id`, `user_id`, `webhooks_enabled`
/// and `locked_in` are read).
///
/// Gathering the census costs a skills-dir scan and a DB round-trip, both
/// pointless when `track_event` would no-op anyway (no OTel endpoint) — as in
/// the local dev loop. Best-effort: a census failure never takes down the boot; it
/// logs `{ err }` `[Startup] agent-started telemetry failed` at warn, the only
/// diagnostic for a census that silently stops arriving.
pub async fn track_agent_started(agent: &AgentWorkspace, opts: TrackAgentStartedOptions) {
    if !is_telemetry_enabled() {
        return;
    }

    if let Err(err) = gather_and_track(agent, opts).await {
        log_warn!(
            json!({ "err": crate::lib::log_redaction::err_json(&err) }),
            "[Startup] agent-started telemetry failed"
        );
    }
}

async fn gather_and_track(
    agent: &AgentWorkspace,
    opts: TrackAgentStartedOptions,
) -> anyhow::Result<()> {
    // No workspaceRoot at boot — this counts the globally installed skills,
    // which includes any a plugin contributes.
    let skills = SKILL_CATALOG_SERVICE.get_catalog(None).await;
    let plugins = PLUGIN_CATALOG_SERVICE.get_plugins().await;
    let subagents = AGENT_WORKSPACE_SERVICE.get_subagents(&agent.id).await?;

    let census = Census {
        agent_id: &agent.id,
        webhooks_enabled: agent.webhooks_enabled,
        locked_in: agent.locked_in,
        cron_tasks: opts.cron_tasks,
        skills: skills.len(),
        plugins: plugins.len(),
        subagents: subagents.len(),
        // Read synchronously — the boot-time models.dev refresh may not have
        // settled yet, and 'pending' (i.e. slower than boot) is itself the useful
        // signal. Deliberately not awaited: the census must never gate on a
        // network call.
        model_catalog_state: model_catalog_state().as_str(),
        execution_environment: get_execution_environment().id().as_str(),
    };
    track_event(
        "agent started",
        Some(&agent.user_id),
        Some(agent_started_props(&CONFIG, &census)),
    );
    Ok(())
}

/// The census's properties, in the order they are sent. Booleans and counts are
/// text.
fn agent_started_props(config: &Config, census: &Census<'_>) -> IndexMap<String, String> {
    let mut props: IndexMap<String, String> = IndexMap::new();
    let mut put = |key: &str, value: String| {
        props.insert(key.to_string(), value);
    };
    put("agent.id", census.agent_id.to_string());
    put("llm.provider", config.llm_provider.as_str().to_string());
    put("llm.routing", llm_routing_for(config).to_string());
    put("llm.chat_model", config.chat_model_id.clone());
    put(
        "llm.classification_model",
        config.classification_model_id.clone(),
    );
    put(
        "model_catalog.state",
        census.model_catalog_state.to_string(),
    );
    // Which vendor embeds memory — its own selection, decoupled from the chat
    // vendor (EMBEDDING_PROVIDER). 'none' only when the selector disabled
    // embeddings; a vendor whose embedding model id is set to '' still reports
    // the vendor, so the disabled signal is the absence of `llm.embedding_model`
    // below, not this value.
    put(
        "llm.embedding_provider",
        config.embedding_provider.as_str().to_string(),
    );
    // Empty when embeddings are disabled (EMBEDDING_PROVIDER=none, or the active
    // `*_EMBEDDING_MODEL_ID` set to '').
    if !config.embedding_model_id.is_empty() {
        put("llm.embedding_model", config.embedding_model_id.clone());
    }
    // Only the AWS endpoints are regional; meaningless on Azure (the resource
    // name pins the region) and on OpenAI/Anthropic (no region at all) — an
    // allowlist, so a new region-less vendor never inherits it.
    if matches!(
        config.llm_provider,
        LlmProviderName::Bedrock | LlmProviderName::BedrockMantle
    ) {
        put("llm.region", config.aws_region.clone());
    }
    put(
        "tool_risk_gate.mode",
        config.tool_risk_gate_mode.as_str().to_string(),
    );
    put("threads.mode", config.thread_mode.as_str().to_string());
    // Which coding agent the coding_agent tools delegate to.
    put("coding_agent", config.coding_agent().as_str().to_string());
    put(
        "execution_environment",
        census.execution_environment.to_string(),
    );
    put("slack.enabled", is_set(&config.slack_bot_token).to_string());
    put(
        "teams.enabled",
        (is_set(&config.teams_app_id)
            && is_set(&config.teams_app_password)
            && is_set(&config.teams_app_tenant_id))
        .to_string(),
    );
    put("nexus.enabled", is_set(&config.nexus_api_url).to_string());
    put(
        "nexus.mcp_enabled",
        is_set(&config.nexus_mcp_url).to_string(),
    );
    put(
        "langfuse.enabled",
        (is_set(&config.langfuse_secret_key) && is_set(&config.langfuse_public_key)).to_string(),
    );
    // Whether the runtime reports the agent's state on stdout (OSC 7501).
    put(
        "program_status.enabled",
        config.program_status_reports.to_string(),
    );
    // The packaged `prism-server` binary vs a container/source run.
    put("runtime.sea", is_sea().to_string());
    put("runtime.platform", node_platform().to_string());
    put("runtime.arch", node_arch().to_string());
    put(
        "webhook.receiver_enabled",
        census.webhooks_enabled.to_string(),
    );
    put("agent.locked_in", census.locked_in.to_string());
    put("cron.tasks", census.cron_tasks.to_string());
    put("skills.count", census.skills.to_string());
    put("plugins.count", census.plugins.to_string());
    put("agent.subagents", census.subagents.to_string());
    props
}

/// JavaScript truthiness of an optional setting: set and non-empty.
fn is_set(value: &Option<String>) -> bool {
    value.as_deref().is_some_and(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Env;

    fn config_with(pairs: &[(&str, &str)]) -> Config {
        let env: Env = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        Config::load(&env, &mut |_, _| {}).expect("config loads")
    }

    struct Agent {
        webhooks_enabled: bool,
    }

    fn agent(webhooks_enabled: bool) -> Agent {
        Agent { webhooks_enabled }
    }

    fn census(agent: &Agent, cron_tasks: usize) -> Census<'static> {
        Census {
            agent_id: "agent-1",
            webhooks_enabled: agent.webhooks_enabled,
            locked_in: false,
            cron_tasks,
            skills: 3,
            plugins: 0,
            subagents: 1,
            model_catalog_state: "bundled",
            execution_environment: "local",
        }
    }

    #[test]
    fn reports_a_bedrock_deployment_through_the_gateway() {
        let config = config_with(&[
            ("LLM_PROVIDER", "bedrock"),
            ("NEXUS_API_URL", "https://gateway.test"),
            ("NEXUS_MCP_URL", "https://gateway.test/projects/p1/mcp"),
            ("SLACK_BOT_TOKEN", "xoxb-test"),
            ("AWS_REGION", "us-east-1"),
        ]);
        let agent = agent(true);
        let props = agent_started_props(&config, &census(&agent, 3));

        assert_eq!(props["agent.id"], "agent-1");
        assert_eq!(props["llm.provider"], "bedrock");
        assert_eq!(props["llm.routing"], "nexus");
        assert_eq!(props["llm.chat_model"], config.chat_model_id);
        assert_eq!(props["llm.embedding_provider"], "bedrock");
        assert_eq!(props["llm.embedding_model"], config.embedding_model_id);
        assert_eq!(props["llm.region"], "us-east-1");
        assert_eq!(props["slack.enabled"], "true");
        assert_eq!(props["nexus.enabled"], "true");
        assert_eq!(props["nexus.mcp_enabled"], "true");
        assert_eq!(props["langfuse.enabled"], "false");
        assert_eq!(props["runtime.sea"], is_sea().to_string());
        assert_eq!(props["runtime.platform"], node_platform());
        assert_eq!(props["runtime.arch"], node_arch());
        assert_eq!(props["webhook.receiver_enabled"], "true");
        assert_eq!(props["cron.tasks"], "3");
        assert_eq!(props["skills.count"], "3");
        assert_eq!(props["agent.subagents"], "1");
    }

    #[test]
    fn sends_the_props_in_order() {
        let config = config_with(&[("LLM_PROVIDER", "bedrock")]);
        let agent = agent(false);
        let props = agent_started_props(&config, &census(&agent, 0));
        let keys: Vec<&str> = props.keys().map(String::as_str).collect();
        assert_eq!(
            keys,
            vec![
                "agent.id",
                "llm.provider",
                "llm.routing",
                "llm.chat_model",
                "llm.classification_model",
                "model_catalog.state",
                "llm.embedding_provider",
                "llm.embedding_model",
                "llm.region",
                "tool_risk_gate.mode",
                "threads.mode",
                "coding_agent",
                "execution_environment",
                "slack.enabled",
                "teams.enabled",
                "nexus.enabled",
                "nexus.mcp_enabled",
                "langfuse.enabled",
                "program_status.enabled",
                "runtime.sea",
                "runtime.platform",
                "runtime.arch",
                "webhook.receiver_enabled",
                "agent.locked_in",
                "cron.tasks",
                "skills.count",
                "plugins.count",
                "agent.subagents",
            ]
        );
    }

    #[test]
    fn reports_direct_routing_and_omits_the_region_on_azure() {
        let config = config_with(&[
            ("LLM_PROVIDER", "azure"),
            ("AZURE_RESOURCE_NAME", "example"),
            ("LANGFUSE_SECRET_KEY", "lf-secret"),
            ("LANGFUSE_PUBLIC_KEY", "lf-public"),
        ]);
        let agent = agent(false);
        let props = agent_started_props(&config, &census(&agent, 0));
        assert_eq!(props["llm.provider"], "azure");
        assert_eq!(props["llm.routing"], "direct");
        assert_eq!(props["llm.embedding_provider"], "azure-openai");
        assert_eq!(props["slack.enabled"], "false");
        assert_eq!(props["nexus.enabled"], "false");
        assert_eq!(props["nexus.mcp_enabled"], "false");
        assert_eq!(props["langfuse.enabled"], "true");
        assert_eq!(props["cron.tasks"], "0");
        assert!(!props.contains_key("llm.region"));
    }

    #[test]
    fn routes_through_the_gateway_on_azure_when_the_gateway_is_set() {
        let config = config_with(&[
            ("LLM_PROVIDER", "azure"),
            ("NEXUS_API_URL", "https://gateway.test"),
        ]);
        let agent = agent(false);
        let props = agent_started_props(&config, &census(&agent, 0));
        assert_eq!(props["llm.routing"], "nexus");
    }

    #[test]
    fn reports_the_region_on_bedrock_mantle() {
        let config = config_with(&[
            ("LLM_PROVIDER", "bedrock-mantle"),
            ("AWS_BEARER_TOKEN_BEDROCK", "token"),
        ]);
        let agent = agent(false);
        let props = agent_started_props(&config, &census(&agent, 0));
        assert_eq!(props["llm.provider"], "bedrock-mantle");
        assert_eq!(props["llm.routing"], "direct");
        // Titan on bedrock-runtime — mantle serves no embeddings.
        assert_eq!(props["llm.embedding_model"], "amazon.titan-embed-text-v2:0");
        assert_eq!(props["llm.region"], "us-east-1");
    }

    #[test]
    fn reports_direct_routing_and_omits_the_region_on_anthropic_beside_the_gateway() {
        let config = config_with(&[
            ("LLM_PROVIDER", "anthropic"),
            ("ANTHROPIC_API_KEY", "key"),
            ("EMBEDDING_PROVIDER", "none"),
            ("NEXUS_API_URL", "https://gateway.test"),
        ]);
        let agent = agent(false);
        let props = agent_started_props(&config, &census(&agent, 0));
        assert_eq!(props["llm.provider"], "anthropic");
        // anthropic has no gateway mount, so routing stays direct.
        assert_eq!(props["llm.routing"], "direct");
        assert_eq!(props["llm.embedding_provider"], "none");
        assert!(!props.contains_key("llm.region"));
        assert!(!props.contains_key("llm.embedding_model"));
    }

    #[test]
    fn omits_the_embedding_model_when_embeddings_are_disabled() {
        let config = config_with(&[("EMBEDDING_PROVIDER", "none")]);
        let agent = agent(false);
        let props = agent_started_props(&config, &census(&agent, 0));
        assert!(!props.contains_key("llm.embedding_model"));
        assert_eq!(props["llm.embedding_provider"], "none");
    }

    #[tokio::test]
    #[serial_test::serial]
    async fn gathers_nothing_when_telemetry_is_disabled() {
        use crate::db::models::NewAgentWorkspace;
        use crate::db::schema::agent_workspaces;
        use diesel::prelude::*;

        let _db = crate::db::testing::test_db();
        let agent: AgentWorkspace = crate::db::run(|conn| {
            let row = NewAgentWorkspace::new(
                "user-1",
                "soul",
                "user",
                "memory",
                "heartbeat",
                "bootstrap",
            );
            diesel::insert_into(agent_workspaces::table)
                .values(&row)
                .execute(conn)?;
            Ok(agent_workspaces::table
                .select(AgentWorkspace::as_select())
                .first(conn)?)
        })
        .await
        .unwrap();
        // The test configuration has no OTEL endpoint; a census that ran would
        // scan skills and query subagents, which nothing here sets up.
        track_agent_started(&agent, TrackAgentStartedOptions { cron_tasks: 0 }).await;
    }
}
