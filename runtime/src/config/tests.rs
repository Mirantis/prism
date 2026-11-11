//! Env var reads and defaults. Each test builds a configuration from an
//! environment of its own, so nothing leaks in from the developer's shell.

use super::*;

const NO_SETTINGS: (&str, &str) = ("PRISM_SETTINGS_PATH", "/nonexistent/prism-settings.json");

fn env(pairs: &[(&str, &str)]) -> Env {
    let mut map: Env = [NO_SETTINGS]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    for (k, v) in pairs {
        map.insert(k.to_string(), v.to_string());
    }
    map
}

/// The configuration and the warnings it logged, as `(fields, message)`.
fn load_with_warnings(pairs: &[(&str, &str)]) -> (anyhow::Result<Config>, Vec<(Value, String)>) {
    let mut warnings = Vec::new();
    let result = Config::load(&env(pairs), &mut |fields, msg| {
        warnings.push((fields, msg.to_string()))
    });
    (result, warnings)
}

fn load(pairs: &[(&str, &str)]) -> Config {
    load_with_warnings(pairs).0.expect("config loads")
}

fn load_err(pairs: &[(&str, &str)]) -> String {
    format!(
        "{:#}",
        load_with_warnings(pairs).0.expect_err("config refuses")
    )
}

#[test]
#[serial_test::serial]
fn unit_tests_read_the_fixed_test_configuration() {
    assert_eq!(CONFIG.agent_id().as_deref(), Some("test-agent-id"));
    assert_eq!(CONFIG.nexus_api_url, None);
    assert!(is_gateway_endpoint(Some(
        "https://gateway.example.com/llm/openai/v1"
    )));
    assert!(!is_gateway_endpoint(Some("https://api.openai.example/v1")));
}

#[test]
fn reads_each_coding_agent_model_override() {
    let claude_defaults = [
        ("small", "haiku", "global.anthropic.claude-haiku-5-5"),
        ("medium", "sonnet", "global.anthropic.claude-sonnet-5-5"),
        ("large", "opus", "opus"),
    ];
    for (tier, default, bedrock) in claude_defaults {
        let name = format!("CLAUDE_CODE_MODEL_{}", tier.to_uppercase());
        let defaults = ClaudeCodeTierModel {
            default: default.into(),
            bedrock: bedrock.into(),
        };
        let cfg = load(&[("LLM_PROVIDER", "anthropic")]);
        assert_eq!(
            cfg.coding_agent_models.claude_code.get(tier),
            Some(&defaults)
        );
        let cfg = load(&[("LLM_PROVIDER", "anthropic"), (&name, "  custom-model  ")]);
        assert_eq!(
            cfg.coding_agent_models.claude_code.get(tier),
            Some(&ClaudeCodeTierModel {
                default: "custom-model".into(),
                bedrock: "custom-model".into()
            })
        );
        let (cfg, warnings) = load_with_warnings(&[("LLM_PROVIDER", "anthropic"), (&name, "   ")]);
        assert_eq!(
            cfg.unwrap().coding_agent_models.claude_code.get(tier),
            Some(&defaults)
        );
        assert!(warnings.contains(&(
            json!({ "variable": name }),
            "[Startup] empty coding agent model override; using the default".to_string()
        )));
    }

    let codex_defaults = [
        ("small", "gpt-5.6-luna", "openai.gpt-5.6-luna"),
        ("medium", "gpt-5.6-terra", "openai.gpt-5.6-terra"),
        ("large", "gpt-5.6-sol", "openai.gpt-5.6-sol"),
    ];
    for (tier, openai, bedrock) in codex_defaults {
        let name = format!("CODEX_MODEL_{}", tier.to_uppercase());
        let defaults = CodexTierModel {
            openai: openai.into(),
            bedrock: bedrock.into(),
        };
        let cfg = load(&[("LLM_PROVIDER", "anthropic")]);
        assert_eq!(cfg.coding_agent_models.codex.get(tier), Some(&defaults));
        let cfg = load(&[("LLM_PROVIDER", "anthropic"), (&name, "  custom-model  ")]);
        assert_eq!(
            cfg.coding_agent_models.codex.get(tier),
            Some(&CodexTierModel {
                openai: "custom-model".into(),
                bedrock: "custom-model".into()
            })
        );
        let (cfg, warnings) = load_with_warnings(&[("LLM_PROVIDER", "anthropic"), (&name, "   ")]);
        assert_eq!(
            cfg.unwrap().coding_agent_models.codex.get(tier),
            Some(&defaults)
        );
        assert!(warnings.contains(&(
            json!({ "variable": name }),
            "[Startup] empty coding agent model override; using the default".to_string()
        )));
    }
}

#[test]
fn keeps_a_bedrock_id_for_a_claude_code_tier_on_bedrock_only() {
    for (tier, model, alias) in [
        ("small", "eu.anthropic.claude-haiku-5-5", "haiku"),
        ("medium", "eu.anthropic.claude-sonnet-5-5", "sonnet"),
        ("medium", "anthropic.claude-sonnet-5-5", "sonnet"),
        (
            "large",
            "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-opus-5-5",
            "opus",
        ),
    ] {
        let name = format!("CLAUDE_CODE_MODEL_{}", tier.to_uppercase());
        let cfg = load(&[("LLM_PROVIDER", "anthropic"), (&name, model)]);
        assert_eq!(
            cfg.coding_agent_models.claude_code.get(tier),
            Some(&ClaudeCodeTierModel {
                default: alias.into(),
                bedrock: model.into()
            })
        );
    }
}

// ---------------------------------------------------------------------------
// public Web UI address
// ---------------------------------------------------------------------------

#[test]
fn uses_the_first_public_web_origin_supplied_by_the_deployment() {
    let cfg = load(&[(
        "NEXUS_INGRESS_ORIGINS_WEB",
        " https://prism.example.com/,https://alias.example.com",
    )]);
    assert_eq!(cfg.public_url.as_deref(), Some("https://prism.example.com"));
}

#[test]
fn matches_a_renamed_exposed_port_to_the_runtime_port() {
    let cfg = load(&[
        ("PORT", "4000"),
        ("LENS_SANDBOX_INGRESS_PORTS", "metrics=9090,agent-ui=4000"),
        (
            "NEXUS_INGRESS_ORIGINS_AGENT_UI",
            "https://agent.example.com",
        ),
        (
            "NEXUS_INGRESS_ORIGINS_METRICS",
            "https://metrics.example.com",
        ),
    ]);
    assert_eq!(cfg.public_url.as_deref(), Some("https://agent.example.com"));
}

#[test]
fn uses_an_explicit_url_including_its_path_prefix_ahead_of_the_deployment_origin() {
    let cfg = load(&[
        (
            "PRISM_PUBLIC_URL",
            " https://custom.example.com/assistant/ ",
        ),
        ("NEXUS_INGRESS_ORIGINS_WEB", "https://prism.example.com"),
    ]);
    assert_eq!(
        cfg.public_url.as_deref(),
        Some("https://custom.example.com/assistant")
    );
}

#[test]
fn uses_the_deployment_origin_when_the_explicit_url_is_blank() {
    let cfg = load(&[
        ("PRISM_PUBLIC_URL", "   "),
        ("NEXUS_INGRESS_ORIGINS_WEB", "https://prism.example.com"),
    ]);
    assert_eq!(cfg.public_url.as_deref(), Some("https://prism.example.com"));
}

#[test]
fn has_no_public_address_without_one() {
    assert_eq!(load(&[]).public_url, None);
}

// ---------------------------------------------------------------------------
// webhook port
// ---------------------------------------------------------------------------

#[test]
fn defaults_the_webhook_port_to_3004_whatever_the_main_port_is() {
    assert_eq!(load(&[("PORT", "4000")]).webhook_port, 3004);
}

#[test]
fn rejects_a_webhook_port_equal_to_the_management_port() {
    assert!(
        load_err(&[("PORT", "4000"), ("WEBHOOK_PORT", "4000")])
            .contains("WEBHOOK_PORT must differ from PORT")
    );
}

#[test]
fn takes_webhook_port() {
    assert_eq!(load(&[("WEBHOOK_PORT", "4010")]).webhook_port, 4010);
}

#[test]
fn uses_the_public_origin_of_the_exposed_webhook_port() {
    let cfg = load(&[
        ("LENS_SANDBOX_INGRESS_PORTS", "web=3003,webhooks=3004"),
        ("NEXUS_INGRESS_ORIGINS_WEB", "https://prism.example.com"),
        (
            "NEXUS_INGRESS_ORIGINS_WEBHOOKS",
            " https://hooks.example.com/,https://alias.example.com",
        ),
    ]);
    assert_eq!(
        cfg.webhook_public_url.as_deref(),
        Some("https://hooks.example.com")
    );
    assert_eq!(cfg.public_url.as_deref(), Some("https://prism.example.com"));
}

#[test]
fn has_no_webhook_origin_when_the_deployment_exposes_only_the_web_port() {
    let cfg = load(&[
        ("LENS_SANDBOX_INGRESS_PORTS", "web=3003"),
        ("NEXUS_INGRESS_ORIGINS_WEB", "https://prism.example.com"),
    ]);
    assert_eq!(cfg.webhook_public_url, None);
}

#[test]
fn checks_the_agent_messages_port() {
    assert_eq!(load(&[]).agent_messages_port, 3005);
    assert!(
        load_err(&[("AGENT_MESSAGES_PORT", "0")])
            .contains("AGENT_MESSAGES_PORT must be a port number")
    );
    assert!(
        load_err(&[("AGENT_MESSAGES_PORT", "3003")])
            .contains("AGENT_MESSAGES_PORT must differ from PORT")
    );
    assert!(
        load_err(&[("AGENT_MESSAGES_PORT", "3004")])
            .contains("AGENT_MESSAGES_PORT must differ from WEBHOOK_PORT")
    );
}

// ---------------------------------------------------------------------------
// bind address
// ---------------------------------------------------------------------------

#[test]
fn reads_port_with_default_3003() {
    assert_eq!(load(&[]).port, 3003);
    assert_eq!(load(&[("PORT", "4000")]).port, 4000);
}

#[test]
fn defaults_the_bind_to_loopback() {
    assert_eq!(load(&[]).host, "127.0.0.1");
}

#[test]
fn reads_prism_host() {
    assert_eq!(load(&[("PRISM_HOST", "0.0.0.0")]).host, "0.0.0.0");
}

#[test]
fn falls_back_to_loopback_for_a_whitespace_only_prism_host() {
    assert_eq!(load(&[("PRISM_HOST", "   ")]).host, "127.0.0.1");
}

#[test]
fn allowed_origins_are_empty_by_default() {
    assert_eq!(load(&[]).allowed_origins, vec![]);
}

#[test]
fn parses_allowed_origins_on_a_widened_bind() {
    let cfg = load(&[
        ("PRISM_HOST", "0.0.0.0"),
        (
            "PRISM_ALLOWED_ORIGINS",
            "https://app.example.com:*, https://b.example.com",
        ),
    ]);
    assert_eq!(
        cfg.allowed_origins,
        vec![
            OriginPattern {
                protocol: "https:".into(),
                hostname: "app.example.com".into(),
                port: "*".into()
            },
            OriginPattern {
                protocol: "https:".into(),
                hostname: "b.example.com".into(),
                port: "".into()
            },
        ]
    );
}

#[test]
fn stops_startup_on_an_invalid_allowed_origin_and_names_it() {
    let err = load_err(&[
        ("PRISM_HOST", "0.0.0.0"),
        (
            "PRISM_ALLOWED_ORIGINS",
            "https://app.example.com,https://*.example.com",
        ),
    ]);
    assert!(
        err.contains("PRISM_ALLOWED_ORIGINS: Invalid origin pattern \"https://*.example.com\""),
        "{err}"
    );
}

#[test]
fn stops_startup_when_the_bind_is_a_loopback_address() {
    for host in [
        "127.0.0.1",
        "localhost",
        "::1",
        "127.1",
        "0x7f.1",
        "2130706433",
        "::ffff:127.0.0.1",
        "0:0:0:0:0:0:0:1",
        "[::1]",
        "localhost.",
        "LOCALHOST",
        "::1%lo0",
        "[::1%lo0]",
        "agent.localhost",
    ] {
        let err = load_err(&[
            ("PRISM_HOST", host),
            ("PRISM_ALLOWED_ORIGINS", "https://app.example.com"),
        ]);
        assert!(
            err.contains(&format!(
                "PRISM_ALLOWED_ORIGINS is set while PRISM_HOST is the loopback address {host}"
            )),
            "{host}: {err}"
        );
    }
}

#[test]
fn starts_on_a_non_loopback_bind_and_keeps_the_address_as_written() {
    for host in [
        "0.0.0.0",
        "::",
        "192.0.2.10",
        "::ffff:192.0.2.10",
        "fe80::1%en0",
    ] {
        let cfg = load(&[
            ("PRISM_HOST", host),
            ("PRISM_ALLOWED_ORIGINS", "https://app.example.com"),
        ]);
        assert_eq!(cfg.host, host);
        assert!(!cfg.listens_on_loopback, "{host}");
    }
}

#[test]
fn keeps_a_loopback_bind_as_written_for_listen() {
    let cfg = load(&[("PRISM_HOST", "127.1")]);
    assert_eq!(cfg.host, "127.1");
    assert!(cfg.listens_on_loopback);
}

#[test]
fn stops_startup_on_the_default_loopback_bind() {
    let err = load_err(&[("PRISM_ALLOWED_ORIGINS", "https://app.example.com")]);
    assert!(
        err.contains("only for a runtime behind an authenticating proxy"),
        "{err}"
    );
}

#[test]
fn starts_on_a_loopback_bind_when_the_list_is_blank() {
    assert_eq!(
        load(&[("PRISM_ALLOWED_ORIGINS", " , ")]).allowed_origins,
        vec![]
    );
}

// ---------------------------------------------------------------------------
// plain reads
// ---------------------------------------------------------------------------

#[test]
fn reads_the_bedrock_model_ids_with_defaults() {
    let cfg = load(&[]);
    assert_eq!(cfg.bedrock_model_id, "global.anthropic.claude-opus-5-5");
    assert_eq!(
        cfg.bedrock_classification_model_id,
        "global.anthropic.claude-haiku-5-5"
    );
}

#[test]
fn reads_aws_region_with_default_us_east_1() {
    assert_eq!(load(&[]).aws_region, "us-east-1");
}

#[test]
fn reads_aws_credential_env_vars() {
    let cfg = load(&[
        ("AWS_ACCESS_KEY_ID", "key-123"),
        ("AWS_SECRET_ACCESS_KEY", "secret-456"),
    ]);
    assert_eq!(cfg.aws_access_key_id.as_deref(), Some("key-123"));
    assert_eq!(cfg.aws_secret_access_key.as_deref(), Some("secret-456"));
}

#[test]
fn uses_the_local_owner_sentinel_when_owner_user_id_is_unset() {
    assert_eq!(
        load(&[]).owner_user_id(),
        "00000000-0000-0000-0000-000000000001"
    );
}

#[test]
fn reads_owner_user_id_agent_name_and_team_name() {
    let cfg = load(&[
        ("OWNER_USER_ID", "owner-uuid"),
        ("AGENT_NAME", "Custom"),
        ("TEAM_NAME", "Acme"),
    ]);
    assert_eq!(cfg.owner_user_id(), "owner-uuid");
    assert_eq!(cfg.agent_name, "Custom");
    assert_eq!(cfg.team_name, "Acme");
}

#[test]
fn defaults_agent_name_to_prism_and_team_name_to_local() {
    let cfg = load(&[]);
    assert_eq!(cfg.agent_name, "Prism");
    assert_eq!(cfg.team_name, "Local");
}

#[test]
fn sets_the_fields_boot_fills_in() {
    let cfg = load(&[]);
    assert_eq!(cfg.agent_id(), None);
    cfg.set_agent_id(Some("agent-1".into()));
    cfg.set_owner_user_id("user-1".into());
    cfg.set_available_coding_agents(vec![CodingAgentName::Codex]);
    cfg.set_coding_agent(CodingAgentName::Codex);
    assert_eq!(cfg.agent_id().as_deref(), Some("agent-1"));
    assert_eq!(cfg.owner_user_id(), "user-1");
    assert_eq!(cfg.available_coding_agents(), vec![CodingAgentName::Codex]);
    assert_eq!(cfg.coding_agent(), CodingAgentName::Codex);
}

#[test]
fn reads_nexus_mcp_url_directly() {
    let cfg = load(&[(
        "NEXUS_MCP_URL",
        "https://gateway.example.com/projects/proj-42/mcp",
    )]);
    assert_eq!(
        cfg.nexus_mcp_url.as_deref(),
        Some("https://gateway.example.com/projects/proj-42/mcp")
    );
}

#[test]
fn nexus_mcp_url_is_none_when_unset_and_never_falls_back_to_the_api_url() {
    assert_eq!(load(&[]).nexus_mcp_url, None);
    assert_eq!(
        load(&[("NEXUS_API_URL", "https://gateway.example.com")]).nexus_mcp_url,
        None
    );
}

#[test]
fn nexus_llm_base_url_is_none_when_nexus_api_url_is_unset() {
    assert_eq!(load(&[]).nexus_llm_base_url, None);
}

#[test]
fn builds_the_auto_resolve_llm_url_when_project_id_is_unset() {
    let cfg = load(&[
        ("NEXUS_API_URL", "https://gateway.example.com"),
        ("AWS_REGION", "us-east-1"),
    ]);
    assert_eq!(
        cfg.nexus_llm_base_url.as_deref(),
        Some("https://gateway.example.com/llm/bedrock/us-east-1")
    );
}

#[test]
fn builds_the_explicit_project_llm_url_when_project_id_is_set() {
    let cfg = load(&[
        ("NEXUS_API_URL", "https://gateway.example.com"),
        ("PROJECT_ID", "proj-42"),
        ("AWS_REGION", "eu-west-1"),
    ]);
    assert_eq!(
        cfg.nexus_llm_base_url.as_deref(),
        Some("https://gateway.example.com/projects/proj-42/llm/bedrock/eu-west-1")
    );
}

// ---------------------------------------------------------------------------
// MODELS_DEV_URL
// ---------------------------------------------------------------------------

#[test]
fn models_dev_url_is_off_unless_a_url_is_named() {
    assert_eq!(load(&[]).models_dev_url, None);
    assert_eq!(load(&[("MODELS_DEV_URL", "")]).models_dev_url, None);
    assert_eq!(load(&[("MODELS_DEV_URL", "   ")]).models_dev_url, None);
    assert_eq!(
        load(&[("MODELS_DEV_URL", "https://models.dev/api.json")])
            .models_dev_url
            .as_deref(),
        Some("https://models.dev/api.json")
    );
    assert_eq!(
        load(&[("MODELS_DEV_URL", "http://fixture.test/api.json")])
            .models_dev_url
            .as_deref(),
        Some("http://fixture.test/api.json")
    );
}

// ---------------------------------------------------------------------------
// HEARTBEAT_INTERVAL_MS
// ---------------------------------------------------------------------------

fn heartbeat_warned(warnings: &[(Value, String)]) -> bool {
    warnings
        .iter()
        .any(|(_, msg)| msg.contains("HEARTBEAT_INTERVAL_MS"))
}

#[test]
fn defaults_the_heartbeat_to_8_hours_when_unset_without_a_warning() {
    let (cfg, warnings) = load_with_warnings(&[]);
    assert_eq!(cfg.unwrap().heartbeat_interval_ms, 28_800_000);
    assert!(!heartbeat_warned(&warnings));
}

#[test]
fn uses_a_valid_heartbeat_interval() {
    for (value, expected) in [
        ("7200000", 7_200_000),
        ("60000", 60_000),
        ("604800000", 604_800_000),
    ] {
        assert_eq!(
            load(&[("HEARTBEAT_INTERVAL_MS", value)]).heartbeat_interval_ms,
            expected
        );
    }
}

#[test]
fn warns_and_uses_8_hours_for_an_invalid_heartbeat_interval() {
    for value in [
        "59999",
        "604800001",
        "2592000000",
        "0",
        "-5",
        "1.5",
        "abc",
        "2h",
    ] {
        let (cfg, warnings) = load_with_warnings(&[("HEARTBEAT_INTERVAL_MS", value)]);
        assert_eq!(cfg.unwrap().heartbeat_interval_ms, 28_800_000, "{value}");
        assert!(
            warnings
                .iter()
                .any(|(fields, msg)| fields["configured"] == value
                    && msg.contains("HEARTBEAT_INTERVAL_MS")),
            "{value}"
        );
    }
}

// ---------------------------------------------------------------------------
// TOOL_RISK_GATE_MODE
// ---------------------------------------------------------------------------

#[test]
fn tool_risk_gate_defaults_to_off_when_unset() {
    let cfg = load(&[]);
    assert_eq!(cfg.tool_risk_gate_mode, ToolRiskGateMode::Off);
    assert_eq!(cfg.invalid_tool_risk_gate_mode, None);
}

#[test]
fn tool_risk_gate_accepts_each_mode() {
    for (text, mode) in [
        ("off", ToolRiskGateMode::Off),
        ("observe", ToolRiskGateMode::Observe),
        ("enforce", ToolRiskGateMode::Enforce),
    ] {
        let cfg = load(&[("TOOL_RISK_GATE_MODE", text)]);
        assert_eq!(cfg.tool_risk_gate_mode, mode);
        assert_eq!(cfg.invalid_tool_risk_gate_mode, None);
    }
}

#[test]
fn tool_risk_gate_is_case_insensitive_and_trims_whitespace() {
    let cfg = load(&[("TOOL_RISK_GATE_MODE", "  ENFORCE  ")]);
    assert_eq!(cfg.tool_risk_gate_mode, ToolRiskGateMode::Enforce);
    assert_eq!(cfg.invalid_tool_risk_gate_mode, None);
}

#[test]
fn tool_risk_gate_falls_back_to_off_and_keeps_an_invalid_value() {
    let cfg = load(&[("TOOL_RISK_GATE_MODE", "enabled")]);
    assert_eq!(cfg.tool_risk_gate_mode, ToolRiskGateMode::Off);
    assert_eq!(cfg.invalid_tool_risk_gate_mode.as_deref(), Some("enabled"));
}

// ---------------------------------------------------------------------------
// LLM_PROVIDER selection
// ---------------------------------------------------------------------------

#[test]
fn defaults_to_bedrock_when_unset() {
    let cfg = load(&[]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Bedrock);
    assert_eq!(cfg.chat_model_id, "global.anthropic.claude-opus-5-5");
}

#[test]
fn preserves_an_explicit_bedrock_chat_model() {
    let cfg = load(&[
        ("LLM_PROVIDER", "bedrock"),
        ("BEDROCK_MODEL_ID", "global.anthropic.claude-opus-5"),
    ]);
    assert_eq!(cfg.bedrock_model_id, "global.anthropic.claude-opus-5");
    assert_eq!(cfg.chat_model_id, "global.anthropic.claude-opus-5");
}

#[test]
fn falls_back_to_bedrock_on_an_unrecognized_provider_and_keeps_it() {
    let cfg = load(&[("LLM_PROVIDER", "Mantle")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Bedrock);
    assert_eq!(cfg.invalid_llm_provider.as_deref(), Some("mantle"));
}

#[test]
fn reports_no_invalid_provider_when_it_is_unset_or_valid() {
    assert_eq!(load(&[]).invalid_llm_provider, None);
    assert_eq!(
        load(&[("LLM_PROVIDER", "litellm")]).invalid_llm_provider,
        None
    );
}

#[test]
fn selects_azure_and_resolves_the_neutral_model_ids_to_deployment_names() {
    let cfg = load(&[("LLM_PROVIDER", "azure")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Azure);
    assert_eq!(cfg.chat_model_id, "claude-opus-5");
    assert_eq!(cfg.classification_model_id, "claude-haiku-5-5");
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");
}

#[test]
fn selects_bedrock_mantle_case_insensitively_and_resolves_the_neutral_model_ids() {
    let cfg = load(&[("LLM_PROVIDER", "Bedrock-Mantle")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::BedrockMantle);
    assert_eq!(cfg.chat_model_id, "anthropic.claude-opus-5");
    assert_eq!(cfg.classification_model_id, "anthropic.claude-haiku-4-5");
    assert_eq!(cfg.embedding_model_id, "amazon.titan-embed-text-v2:0");
}

#[test]
fn mantle_defaults_are_bare_and_never_inherit_the_prefixed_bedrock_values() {
    let cfg = load(&[("LLM_PROVIDER", "bedrock-mantle")]);
    for prefix in ["us.", "eu.", "apac.", "global."] {
        assert!(!cfg.chat_model_id.starts_with(prefix));
        assert!(!cfg.classification_model_id.starts_with(prefix));
    }
    let cfg = load(&[
        ("LLM_PROVIDER", "bedrock-mantle"),
        ("BEDROCK_MODEL_ID", "us.anthropic.claude-opus-4-8"),
    ]);
    assert_eq!(cfg.chat_model_id, "anthropic.claude-opus-5");
}

#[test]
fn an_empty_mantle_embedding_model_disables_embeddings() {
    let cfg = load(&[
        ("LLM_PROVIDER", "bedrock-mantle"),
        ("BEDROCK_MANTLE_EMBEDDING_MODEL_ID", ""),
    ]);
    assert_eq!(cfg.embedding_model_id, "");
}

#[test]
fn selects_openrouter_and_resolves_vendor_qualified_model_ids() {
    let cfg = load(&[("LLM_PROVIDER", "OpenRouter")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Openrouter);
    let vendor_qualified = regex::Regex::new(r"^[a-z0-9-]+/").unwrap();
    assert!(vendor_qualified.is_match(&cfg.chat_model_id));
    assert!(vendor_qualified.is_match(&cfg.classification_model_id));
}

#[test]
fn routes_openrouter_through_the_openrouter_mount() {
    let cfg = load(&[
        ("LLM_PROVIDER", "openrouter"),
        ("NEXUS_API_URL", "https://gateway.example.com"),
        ("PROJECT_ID", "proj-1"),
    ]);
    assert_eq!(
        cfg.nexus_chat_base_url.as_deref(),
        Some("https://gateway.example.com/projects/proj-1/llm/openrouter/openai/v1")
    );
}

#[test]
fn exposes_the_openrouter_key_and_endpoint_override_for_direct_mode() {
    let cfg = load(&[
        ("LLM_PROVIDER", "openrouter"),
        (
            "OPENROUTER_API_KEY",
            "__nexus_cred:00000000-0000-0000-0000-000000000000__",
        ),
        ("OPENROUTER_BASE_URL", "https://proxy.example/openrouter/v1"),
    ]);
    assert_eq!(
        cfg.openrouter_api_key.as_deref(),
        Some("__nexus_cred:00000000-0000-0000-0000-000000000000__")
    );
    assert_eq!(
        cfg.openrouter_endpoint,
        "https://proxy.example/openrouter/v1"
    );
}

#[test]
fn disables_embeddings_on_openrouter_by_default() {
    assert_eq!(
        load(&[("LLM_PROVIDER", "openrouter")]).embedding_model_id,
        ""
    );
}

#[test]
fn selects_openai_case_insensitively_and_resolves_the_neutral_model_ids() {
    let cfg = load(&[("LLM_PROVIDER", "OpenAI")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Openai);
    assert_eq!(cfg.chat_model_id, "gpt-5.6-sol");
    assert_eq!(cfg.classification_model_id, "gpt-5.6-luna");
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");
}

#[test]
fn an_empty_openai_embedding_model_disables_embeddings() {
    let cfg = load(&[
        ("LLM_PROVIDER", "openai"),
        ("OPENAI_EMBEDDING_MODEL_ID", ""),
    ]);
    assert_eq!(cfg.embedding_model_id, "");
}

#[test]
fn reads_openai_base_url_as_the_endpoint_override() {
    assert_eq!(load(&[]).openai_endpoint, None);
    assert_eq!(
        load(&[("OPENAI_BASE_URL", "https://gw.example/openai/v1")])
            .openai_endpoint
            .as_deref(),
        Some("https://gw.example/openai/v1")
    );
}

#[test]
fn selects_anthropic_case_insensitively_and_resolves_bare_first_party_model_ids() {
    let cfg = load(&[("LLM_PROVIDER", "Anthropic")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Anthropic);
    assert_eq!(cfg.chat_model_id, "claude-opus-5");
    assert_eq!(cfg.classification_model_id, "claude-haiku-5-5");
}

#[test]
fn anthropic_without_an_openai_key_or_gateway_runs_without_embeddings() {
    let cfg = load(&[("LLM_PROVIDER", "anthropic")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::None);
    assert_eq!(cfg.embedding_model_id, "");
}

#[test]
fn anthropic_with_an_openai_key_borrows_openai_embeddings() {
    let cfg = load(&[("LLM_PROVIDER", "anthropic"), ("OPENAI_API_KEY", "sk-test")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Openai);
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");
}

#[test]
fn anthropic_without_a_local_key_still_embeds_through_the_gateway_openai_mount() {
    let cfg = load(&[
        ("LLM_PROVIDER", "anthropic"),
        ("NEXUS_API_URL", "https://gateway.example.com"),
    ]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Openai);
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");
}

#[test]
fn reads_the_anthropic_key_and_base_url_verbatim() {
    let cfg = load(&[("ANTHROPIC_API_KEY", "__nexus_cred:1234-uuid__")]);
    assert_eq!(
        cfg.anthropic_api_key.as_deref(),
        Some("__nexus_cred:1234-uuid__")
    );
    assert_eq!(cfg.anthropic_base_url, None);
    let cfg = load(&[("ANTHROPIC_BASE_URL", "https://gw.example/anthropic/v1")]);
    assert_eq!(
        cfg.anthropic_base_url.as_deref(),
        Some("https://gw.example/anthropic/v1")
    );
}

#[test]
fn selects_litellm_with_the_first_party_names_of_the_default_models() {
    let cfg = load(&[("LLM_PROVIDER", "LiteLLM")]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Litellm);
    assert_eq!(cfg.chat_model_id, "claude-opus-5-5");
    assert_eq!(cfg.classification_model_id, "claude-haiku-5-5");
}

#[test]
fn reads_the_proxy_aliases_for_litellm() {
    let cfg = load(&[
        ("LLM_PROVIDER", "litellm"),
        ("LITELLM_MODEL_ID", "opus"),
        ("LITELLM_CLASSIFICATION_MODEL_ID", "haiku"),
    ]);
    assert_eq!(cfg.chat_model_id, "opus");
    assert_eq!(cfg.classification_model_id, "haiku");
}

#[test]
fn litellm_runs_without_embeddings_by_default() {
    let cfg = load(&[("LLM_PROVIDER", "litellm"), ("OPENAI_API_KEY", "sk-test")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::None);
    assert_eq!(cfg.embedding_model_id, "");
}

#[test]
fn litellm_direct_reads_its_endpoint_and_key() {
    let cfg = load(&[
        ("LLM_PROVIDER", "litellm"),
        ("LITELLM_BASE_URL", "https://litellm.example.com/v1"),
        ("LITELLM_API_KEY", "__nexus_cred:1234-uuid__"),
    ]);
    assert_eq!(
        cfg.litellm_endpoint.as_deref(),
        Some("https://litellm.example.com/v1")
    );
    assert_eq!(
        cfg.litellm_api_key.as_deref(),
        Some("__nexus_cred:1234-uuid__")
    );
    assert_eq!(cfg.chat_routing, ChatRouting::Direct);
}

#[test]
fn normalises_the_litellm_base_url_to_end_at_v1() {
    for value in [
        "https://litellm.example.com",
        "https://litellm.example.com/v1/",
        "https://litellm.example.com//",
        "https://litellm.example.com/v1",
    ] {
        let cfg = load(&[("LLM_PROVIDER", "litellm"), ("LITELLM_BASE_URL", value)]);
        assert_eq!(
            cfg.litellm_endpoint.as_deref(),
            Some("https://litellm.example.com/v1"),
            "{value}"
        );
    }
}

#[test]
fn litellm_has_no_endpoint_without_a_base_url_or_the_gateway() {
    assert_eq!(load(&[("LLM_PROVIDER", "litellm")]).litellm_endpoint, None);
}

// ---------------------------------------------------------------------------
// EMBEDDING_PROVIDER selection
// ---------------------------------------------------------------------------

#[test]
fn derives_each_chat_vendors_embedding_provider() {
    let cfg = load(&[]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Bedrock);
    assert_eq!(cfg.embedding_model_id, "amazon.titan-embed-text-v2:0");

    let cfg = load(&[("LLM_PROVIDER", "azure")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::AzureOpenai);
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");

    let cfg = load(&[("LLM_PROVIDER", "bedrock-mantle")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Bedrock);
    assert_eq!(cfg.embedding_model_id, "amazon.titan-embed-text-v2:0");

    let cfg = load(&[("LLM_PROVIDER", "openai")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Openai);
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");

    let cfg = load(&[("LLM_PROVIDER", "openrouter")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Openrouter);
    assert_eq!(cfg.embedding_model_id, "");
}

#[test]
fn switches_openrouter_embeddings_on_when_a_model_id_is_named() {
    let cfg = load(&[
        ("LLM_PROVIDER", "openrouter"),
        (
            "OPENROUTER_EMBEDDING_MODEL_ID",
            "openai/text-embedding-3-small",
        ),
    ]);
    assert_eq!(cfg.embedding_model_id, "openai/text-embedding-3-small");
}

#[test]
fn an_explicit_embedding_provider_wins_over_the_derived_default() {
    let cfg = load(&[
        ("LLM_PROVIDER", "bedrock"),
        ("EMBEDDING_PROVIDER", "openai"),
    ]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Openai);
    assert_eq!(cfg.embedding_model_id, "text-embedding-3-small");
}

#[test]
fn embedding_provider_is_case_insensitive_and_tolerates_stray_whitespace() {
    for messy in ["Azure-OpenAI", " azure-openai ", "AZURE-OPENAI"] {
        assert_eq!(
            load(&[("EMBEDDING_PROVIDER", messy)]).embedding_provider,
            EmbeddingProviderName::AzureOpenai
        );
    }
}

#[test]
fn embedding_provider_none_disables_embeddings_entirely() {
    let cfg = load(&[("EMBEDDING_PROVIDER", "none")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::None);
    assert_eq!(cfg.embedding_model_id, "");
    assert_eq!(cfg.invalid_embedding_provider, None);
}

#[test]
fn falls_back_to_the_derived_embedding_provider_and_keeps_an_invalid_value() {
    let cfg = load(&[("EMBEDDING_PROVIDER", "voyage")]);
    assert_eq!(cfg.embedding_provider, EmbeddingProviderName::Bedrock);
    assert_eq!(cfg.invalid_embedding_provider.as_deref(), Some("voyage"));
    assert_eq!(load(&[]).invalid_embedding_provider, None);
}

#[test]
fn an_empty_mantle_embedding_model_disables_even_under_an_explicit_bedrock_selection() {
    let cfg = load(&[
        ("LLM_PROVIDER", "bedrock-mantle"),
        ("EMBEDDING_PROVIDER", "bedrock"),
        ("BEDROCK_MANTLE_EMBEDDING_MODEL_ID", ""),
    ]);
    assert_eq!(cfg.embedding_model_id, "");
}

// ---------------------------------------------------------------------------
// bedrock-mantle endpoints
// ---------------------------------------------------------------------------

#[test]
fn derives_the_mantle_direct_endpoint_from_the_region() {
    let cfg = load(&[("AWS_REGION", "eu-central-1")]);
    assert_eq!(
        cfg.bedrock_mantle_direct_endpoint,
        "https://bedrock-mantle.eu-central-1.api.aws/anthropic/v1"
    );
}

#[test]
fn bedrock_mantle_base_url_overrides_the_derived_endpoint() {
    let cfg = load(&[(
        "BEDROCK_MANTLE_BASE_URL",
        "https://mantle.internal/anthropic/v1",
    )]);
    assert_eq!(
        cfg.bedrock_mantle_direct_endpoint,
        "https://mantle.internal/anthropic/v1"
    );
}

#[test]
fn reads_the_bedrock_api_key() {
    let cfg = load(&[("AWS_BEARER_TOKEN_BEDROCK", "bedrock-api-key")]);
    assert_eq!(cfg.bedrock_api_key.as_deref(), Some("bedrock-api-key"));
}

#[test]
fn builds_the_mantle_mounts() {
    assert_eq!(load(&[]).nexus_bedrock_mantle_base_url, None);
    let cfg = load(&[
        ("NEXUS_API_URL", "https://gateway.example.com"),
        ("AWS_REGION", "us-east-1"),
    ]);
    assert_eq!(
        cfg.nexus_bedrock_mantle_base_url.as_deref(),
        Some("https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1")
    );
    let cfg = load(&[
        ("NEXUS_API_URL", "https://gateway.example.com"),
        ("PROJECT_ID", "proj-42"),
        ("AWS_REGION", "eu-west-1"),
    ]);
    assert_eq!(
        cfg.nexus_bedrock_mantle_base_url.as_deref(),
        Some(
            "https://gateway.example.com/projects/proj-42/llm/bedrock-mantle/anthropic/eu-west-1/v1"
        )
    );
}

// ---------------------------------------------------------------------------
// nexus_chat_base_url
// ---------------------------------------------------------------------------

const GATEWAY: (&str, &str) = ("NEXUS_API_URL", "https://gateway.example.com");

fn chat_base(provider: &str) -> Option<String> {
    load(&[GATEWAY, ("LLM_PROVIDER", provider)]).nexus_chat_base_url
}

#[test]
fn chooses_each_vendors_gateway_chat_mount() {
    assert_eq!(
        chat_base("bedrock").as_deref(),
        Some("https://gateway.example.com/llm/bedrock/us-east-1")
    );
    assert_eq!(
        chat_base("azure").as_deref(),
        Some("https://gateway.example.com/llm/azure/anthropic/v1")
    );
    assert_eq!(
        chat_base("bedrock-mantle").as_deref(),
        Some("https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1")
    );
    assert_eq!(
        chat_base("openai").as_deref(),
        Some("https://gateway.example.com/llm/openai/v1")
    );
    assert_eq!(
        chat_base("litellm").as_deref(),
        Some("https://gateway.example.com/llm/litellm/anthropic/v1")
    );
    // No mount serves api.anthropic.com.
    assert_eq!(chat_base("anthropic"), None);
}

#[test]
fn keeps_the_bedrock_runtime_mount_on_mantle() {
    let cfg = load(&[GATEWAY, ("LLM_PROVIDER", "bedrock-mantle")]);
    assert_eq!(
        cfg.nexus_llm_base_url.as_deref(),
        Some("https://gateway.example.com/llm/bedrock/us-east-1")
    );
}

#[test]
fn builds_the_explicit_project_openai_and_litellm_mounts() {
    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "openai"),
        ("PROJECT_ID", "proj-42"),
    ]);
    assert_eq!(
        cfg.nexus_openai_base_url.as_deref(),
        Some("https://gateway.example.com/projects/proj-42/llm/openai/v1")
    );
    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "litellm"),
        ("PROJECT_ID", "proj-42"),
    ]);
    assert_eq!(
        cfg.litellm_endpoint.as_deref(),
        Some("https://gateway.example.com/projects/proj-42/llm/litellm/anthropic/v1")
    );
}

#[test]
fn has_no_chat_mount_without_a_gateway() {
    assert_eq!(
        load(&[("LLM_PROVIDER", "bedrock-mantle")]).nexus_chat_base_url,
        None
    );
    let cfg = load(&[("LLM_PROVIDER", "openai")]);
    assert_eq!(cfg.nexus_chat_base_url, None);
    assert_eq!(cfg.nexus_openai_base_url, None);
}

// ---------------------------------------------------------------------------
// endpoint precedence: override, then gateway mount, then vendor host
// ---------------------------------------------------------------------------

#[test]
fn an_override_wins_over_the_derived_mount() {
    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "openai"),
        (
            "OPENAI_BASE_URL",
            "https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1",
        ),
    ]);
    assert_eq!(
        cfg.openai_endpoint.as_deref(),
        Some("https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1")
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);

    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "openrouter"),
        ("OPENROUTER_BASE_URL", "https://proxy.example/openrouter/v1"),
    ]);
    assert_eq!(
        cfg.openrouter_endpoint,
        "https://proxy.example/openrouter/v1"
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);

    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "litellm"),
        ("LITELLM_BASE_URL", "https://litellm.example.com/v1"),
    ]);
    assert_eq!(
        cfg.litellm_endpoint.as_deref(),
        Some("https://litellm.example.com/v1")
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);
    assert_eq!(cfg.chat_routing, ChatRouting::Direct);

    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "azure"),
        ("AZURE_RESOURCE_NAME", "example-resource"),
        (
            "AZURE_FOUNDRY_BASE_URL",
            "https://foundry.example/anthropic/v1",
        ),
    ]);
    assert_eq!(
        cfg.azure_chat_endpoint.as_deref(),
        Some("https://foundry.example/anthropic/v1")
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);

    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "bedrock-mantle"),
        (
            "BEDROCK_MANTLE_BASE_URL",
            "https://mantle.internal/anthropic/v1",
        ),
    ]);
    assert_eq!(
        cfg.bedrock_mantle_chat_endpoint,
        "https://mantle.internal/anthropic/v1"
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);
}

#[test]
fn takes_the_gateway_mount_when_no_override_is_set() {
    let cfg = load(&[GATEWAY, ("LLM_PROVIDER", "openai")]);
    assert_eq!(
        cfg.openai_endpoint.as_deref(),
        Some("https://gateway.example.com/llm/openai/v1")
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Gateway);
    assert_eq!(cfg.chat_routing, ChatRouting::Nexus);

    for provider in [
        "azure",
        "bedrock-mantle",
        "openrouter",
        "litellm",
        "bedrock",
    ] {
        let cfg = load(&[
            GATEWAY,
            ("LLM_PROVIDER", provider),
            ("AZURE_RESOURCE_NAME", "example-resource"),
        ]);
        assert_eq!(
            cfg.chat_endpoint_source,
            ChatEndpointSource::Gateway,
            "{provider}"
        );
        assert_eq!(cfg.chat_routing, ChatRouting::Nexus, "{provider}");
    }
}

#[test]
fn takes_the_vendor_host_when_neither_an_override_nor_a_gateway_is_set() {
    let cfg = load(&[("LLM_PROVIDER", "openrouter")]);
    assert_eq!(cfg.openrouter_endpoint, "https://openrouter.ai/api/v1");
    assert_eq!(cfg.azure_chat_endpoint, None);
    assert_eq!(
        cfg.bedrock_mantle_chat_endpoint,
        "https://bedrock-mantle.us-east-1.api.aws/anthropic/v1"
    );
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Direct);
    assert_eq!(cfg.chat_routing, ChatRouting::Direct);
}

#[test]
fn routes_an_override_by_its_host() {
    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "openai"),
        ("OPENAI_BASE_URL", "https://api.openai.example/v1"),
    ]);
    assert_eq!(cfg.chat_routing, ChatRouting::Direct);
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);

    // `Override` says the operator named the endpoint, `Nexus` says the gateway
    // still holds the vendor key.
    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "openai"),
        (
            "OPENAI_BASE_URL",
            "https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1",
        ),
    ]);
    assert_eq!(cfg.chat_routing, ChatRouting::Nexus);
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);
}

#[test]
fn anthropic_ignores_the_gateway_and_reports_its_own_endpoint() {
    let cfg = load(&[
        GATEWAY,
        ("LLM_PROVIDER", "anthropic"),
        ("ANTHROPIC_BASE_URL", "https://anthropic.example/v1"),
    ]);
    assert_eq!(cfg.chat_routing, ChatRouting::Direct);
    assert_eq!(cfg.chat_endpoint_source, ChatEndpointSource::Override);
}

// ---------------------------------------------------------------------------
// is_gateway_endpoint
// ---------------------------------------------------------------------------

#[test]
fn matches_any_mount_on_the_gateway_host() {
    let cfg = load(&[GATEWAY]);
    assert!(cfg.is_gateway_endpoint(Some("https://gateway.example.com/llm/openai/v1")));
    assert!(cfg.is_gateway_endpoint(Some(
        "https://GATEWAY.example.com/projects/p/llm/openrouter/openai/v1"
    )));
    assert!(cfg.is_gateway_endpoint(Some("https://gateway.example.com:443/llm/openai/v1")));
}

#[test]
fn rejects_another_host_scheme_or_port() {
    let cfg = load(&[GATEWAY]);
    assert!(!cfg.is_gateway_endpoint(Some("https://api.openai.example/v1")));
    assert!(!cfg.is_gateway_endpoint(Some("http://gateway.example.com/llm/openai/v1")));
    assert!(!cfg.is_gateway_endpoint(Some("https://gateway.example.com:8443/llm/openai/v1")));
}

#[test]
fn answers_false_for_an_unset_or_unparseable_endpoint() {
    let cfg = load(&[GATEWAY]);
    assert!(!cfg.is_gateway_endpoint(None));
    assert!(!cfg.is_gateway_endpoint(Some("")));
    assert!(!cfg.is_gateway_endpoint(Some("not-a-url")));
}

#[test]
fn answers_false_for_every_endpoint_without_a_gateway() {
    assert!(!load(&[]).is_gateway_endpoint(Some("https://gateway.example.com/llm/openai/v1")));
}

#[test]
fn answers_false_when_the_gateway_names_no_http_scheme() {
    let cfg = load(&[("NEXUS_API_URL", "gateway.example.com:8443")]);
    assert!(!cfg.is_gateway_endpoint(Some("gateway.example.com:8443")));
    assert!(!cfg.is_gateway_endpoint(Some("mailto:operator@endpoint.example")));
}

// ---------------------------------------------------------------------------
// chat_endpoint_for_log
// ---------------------------------------------------------------------------

#[test]
fn logs_origin_and_path_only() {
    let cfg = load(&[
        ("LLM_PROVIDER", "openai"),
        (
            "OPENAI_BASE_URL",
            "https://operator:invented-p4ssw0rd@endpoint.example/llm/openai/v1?api_key=invented-token",
        ),
    ]);
    assert_eq!(
        cfg.chat_endpoint_for_log,
        "https://endpoint.example/llm/openai/v1"
    );
}

#[test]
fn names_an_unparseable_endpoint_rather_than_printing_it() {
    let cfg = load(&[
        ("LLM_PROVIDER", "openai"),
        (
            "OPENAI_BASE_URL",
            "endpoint.example/v1?api_key=invented-token",
        ),
    ]);
    assert_eq!(cfg.chat_endpoint_for_log, "invalid");
}

#[test]
fn says_so_when_the_vendor_default_applies() {
    assert_eq!(
        load(&[("LLM_PROVIDER", "openai")]).chat_endpoint_for_log,
        "vendor default"
    );
}

// ---------------------------------------------------------------------------
// compaction
// ---------------------------------------------------------------------------

#[test]
fn defaults_the_compaction_threshold_to_90_and_the_tail_to_6() {
    let cfg = load(&[]);
    assert_eq!(cfg.compaction_threshold_percent, Some(90));
    assert_eq!(cfg.compaction_tail_messages, 6);
}

#[test]
fn reads_compaction_overrides() {
    assert_eq!(
        load(&[("COMPACTION_THRESHOLD_PERCENT", "75")]).compaction_threshold_percent,
        Some(75)
    );
    assert_eq!(
        load(&[("COMPACTION_THRESHOLD_PERCENT", "0")]).compaction_threshold_percent,
        None
    );
    assert_eq!(
        load(&[("COMPACTION_TAIL_MESSAGES", "0")]).compaction_tail_messages,
        0
    );
}

#[test]
fn falls_back_on_junk_compaction_values() {
    for bad in ["nonsense", "-5", "101"] {
        assert_eq!(
            load(&[("COMPACTION_THRESHOLD_PERCENT", bad)]).compaction_threshold_percent,
            Some(90),
            "{bad}"
        );
    }
    for bad in ["nope", "-1"] {
        assert_eq!(
            load(&[("COMPACTION_TAIL_MESSAGES", bad)]).compaction_tail_messages,
            6,
            "{bad}"
        );
    }
}

// ---------------------------------------------------------------------------
// voice meetings
// ---------------------------------------------------------------------------

#[test]
fn selects_managed_azure_voice_while_keeping_bedrock_chat() {
    let cfg = load(&[
        ("LLM_PROVIDER", "bedrock"),
        ("LENS_MANAGED_INFERENCE_PROVIDER", "bedrock"),
        ("LENS_MANAGED_INFERENCE_PROVIDERS", r#"["bedrock","azure"]"#),
        (
            "LENS_INFERENCE_AZURE_OPENAI_BASE_URL",
            "https://lens.example/v1/projects/p/llm/azure/openai/v1",
        ),
        (
            "LENS_INFERENCE_AZURE_OPENAI_API_KEY",
            "__lens_cred:nexus-llm-azure-openai__",
        ),
        ("OPENAI_REALTIME_MODEL", "voice-deployment"),
    ]);
    assert_eq!(cfg.llm_provider, LlmProviderName::Bedrock);
    assert_eq!(cfg.realtime_provider.as_deref(), Some("azure"));
    assert_eq!(cfg.realtime_source, RealtimeSource::Managed);
    assert_eq!(
        cfg.openai_realtime_url.as_deref(),
        Some("wss://lens.example/v1/projects/p/llm/azure/openai/v1/realtime")
    );
    assert_eq!(
        cfg.openai_realtime_api_key.as_deref(),
        Some("__lens_cred:nexus-llm-azure-openai__")
    );
    assert_eq!(cfg.openai_realtime_model, "voice-deployment");
}

#[test]
fn selects_managed_openai_voice_independently_of_chat() {
    for provider in ["bedrock", "azure", "openai"] {
        let cfg = load(&[
            ("LLM_PROVIDER", provider),
            ("OPENAI_API_KEY", "chat-key"),
            ("OPENAI_BASE_URL", "https://chat.example/v1"),
            (
                "LENS_INFERENCE_OPENAI_BASE_URL",
                "https://lens.example/prefix/v1/projects/p/llm/openai/v1/",
            ),
            (
                "LENS_INFERENCE_OPENAI_API_KEY",
                "__lens_cred:nexus-llm-openai__",
            ),
        ]);
        assert_eq!(
            cfg.openai_realtime_url.as_deref(),
            Some("wss://lens.example/prefix/v1/projects/p/llm/openai/v1/realtime")
        );
        assert_eq!(
            cfg.openai_realtime_api_key.as_deref(),
            Some("__lens_cred:nexus-llm-openai__")
        );
        assert_eq!(cfg.openai_api_key.as_deref(), Some("chat-key"));
        assert_eq!(
            cfg.openai_endpoint.as_deref(),
            Some("https://chat.example/v1")
        );
    }
}

#[test]
fn preserves_explicit_voice_overrides_over_managed_discovery() {
    let cfg = load(&[
        ("LENS_INFERENCE_OPENAI_BASE_URL", "https://lens.example/v1"),
        ("LENS_INFERENCE_OPENAI_API_KEY", "managed-key"),
        ("OPENAI_REALTIME_URL", "wss://voice.example/realtime"),
        ("OPENAI_REALTIME_API_KEY", "voice-key"),
    ]);
    assert_eq!(
        cfg.openai_realtime_url.as_deref(),
        Some("wss://voice.example/realtime")
    );
    assert_eq!(cfg.openai_realtime_api_key.as_deref(), Some("voice-key"));
}

#[test]
fn does_not_send_a_managed_credential_to_an_explicit_voice_host() {
    let cfg = load(&[
        ("LENS_INFERENCE_OPENAI_BASE_URL", "https://lens.example/v1"),
        ("LENS_INFERENCE_OPENAI_API_KEY", "managed-key"),
        ("OPENAI_REALTIME_URL", "wss://voice.example/realtime"),
    ]);
    assert_eq!(cfg.openai_realtime_api_key, None);
}

#[test]
fn does_not_borrow_the_chat_key_when_managed_voice_has_no_credential() {
    let cfg = load(&[
        ("LENS_INFERENCE_OPENAI_BASE_URL", "https://lens.example/v1"),
        ("OPENAI_API_KEY", "azure-chat-key"),
    ]);
    assert_eq!(cfg.openai_realtime_api_key, None);
}

#[test]
fn allows_an_independent_direct_voice_key_without_enabling_openai_chat() {
    let cfg = load(&[("OPENAI_REALTIME_API_KEY", "voice-only-key")]);
    assert_eq!(
        cfg.openai_realtime_api_key.as_deref(),
        Some("voice-only-key")
    );
    assert_eq!(cfg.openai_api_key, None);
    assert_eq!(cfg.openai_realtime_url, None);
}

#[test]
fn derives_a_plaintext_websocket_url_for_a_loopback_managed_test_endpoint() {
    let cfg = load(&[
        ("LENS_INFERENCE_OPENAI_BASE_URL", "http://127.0.0.1:1234/v1"),
        ("LENS_INFERENCE_OPENAI_API_KEY", "local-voice-key"),
    ]);
    assert_eq!(
        cfg.openai_realtime_url.as_deref(),
        Some("ws://127.0.0.1:1234/v1/realtime")
    );
}

#[test]
fn reads_the_openai_key_verbatim() {
    assert_eq!(load(&[]).openai_api_key, None);
    let cfg = load(&[("OPENAI_API_KEY", "__nexus_cred:1234-uuid__")]);
    assert_eq!(
        cfg.openai_api_key.as_deref(),
        Some("__nexus_cred:1234-uuid__")
    );
    assert_eq!(
        cfg.openai_realtime_api_key.as_deref(),
        Some("__nexus_cred:1234-uuid__")
    );
}

#[test]
fn pins_the_realtime_model_and_voice() {
    let cfg = load(&[]);
    assert_eq!(cfg.openai_realtime_model, "gpt-realtime-2.1");
    assert_eq!(cfg.openai_realtime_voice, "marin");
    assert_eq!(
        load(&[("OPENAI_REALTIME_MODEL", "gpt-realtime-mini")]).openai_realtime_model,
        "gpt-realtime-mini"
    );
    assert_eq!(
        load(&[("OPENAI_REALTIME_VOICE", "cedar")]).openai_realtime_voice,
        "cedar"
    );
}

#[test]
fn reads_the_realtime_reasoning_effort() {
    assert_eq!(
        load(&[]).openai_realtime_reasoning_effort,
        Some(RealtimeReasoningEffort::High)
    );
    for level in ["minimal", "low", "medium", "high", "xhigh"] {
        let cfg = load(&[("OPENAI_REALTIME_REASONING_EFFORT", level)]);
        assert_eq!(
            cfg.openai_realtime_reasoning_effort.map(|e| e.as_str()),
            Some(level)
        );
    }
    for empty in ["", "   "] {
        assert_eq!(
            load(&[("OPENAI_REALTIME_REASONING_EFFORT", empty)]).openai_realtime_reasoning_effort,
            None
        );
    }
    for messy in [" medium", "Medium", "MEDIUM "] {
        assert_eq!(
            load(&[("OPENAI_REALTIME_REASONING_EFFORT", messy)]).openai_realtime_reasoning_effort,
            Some(RealtimeReasoningEffort::Medium)
        );
    }
    for bad in ["very-high", "none", "off", "3"] {
        assert_eq!(
            load(&[("OPENAI_REALTIME_REASONING_EFFORT", bad)]).openai_realtime_reasoning_effort,
            Some(RealtimeReasoningEffort::High)
        );
    }
}

#[test]
fn reads_the_meeting_limits() {
    assert_eq!(load(&[]).meeting_timeout_minutes, 60);
    assert_eq!(
        load(&[("MEETING_TIMEOUT_MINUTES", "15")]).meeting_timeout_minutes,
        15
    );
    for bad in ["soon", "0", "-10"] {
        assert_eq!(
            load(&[("MEETING_TIMEOUT_MINUTES", bad)]).meeting_timeout_minutes,
            60
        );
    }
    assert_eq!(load(&[]).meeting_admission_timeout_ms, 300_000);
    assert_eq!(
        load(&[("MEETING_ADMISSION_TIMEOUT_SECONDS", "30")]).meeting_admission_timeout_ms,
        30_000
    );
    for bad in ["later", "0"] {
        assert_eq!(
            load(&[("MEETING_ADMISSION_TIMEOUT_SECONDS", bad)]).meeting_admission_timeout_ms,
            300_000
        );
    }
}

#[test]
fn keeps_a_meeting_out_of_the_logs_unless_asked() {
    assert_eq!(
        load(&[]).meeting_transcript_logging,
        MeetingTranscriptLogging::Off
    );
    for full in ["full", "FULL ", " Full"] {
        assert_eq!(
            load(&[("MEETING_TRANSCRIPT_LOGGING", full)]).meeting_transcript_logging,
            MeetingTranscriptLogging::Full
        );
    }
    for off in ["on", "true", "1", "verbose", "redacted", "", "   "] {
        assert_eq!(
            load(&[("MEETING_TRANSCRIPT_LOGGING", off)]).meeting_transcript_logging,
            MeetingTranscriptLogging::Off
        );
    }
}

#[test]
fn stops_startup_when_auto_model_selection_lacks_its_tiers() {
    let err = load_err(&[("MODEL_MODE", "auto")]);
    assert!(
        err.contains("MODEL_MODE=auto needs AUTO_MODEL_SMALL and AUTO_MODEL_LARGE"),
        "{err}"
    );
    let cfg = load(&[
        ("MODEL_MODE", " Auto "),
        ("AUTO_MODEL_SMALL", "s"),
        ("AUTO_MODEL_LARGE", " l "),
    ]);
    assert_eq!(cfg.model_selection.mode, ModelSelectionMode::Auto);
    assert_eq!(cfg.model_selection.tiers.large.as_deref(), Some("l"));
    assert_eq!(cfg.model_selection.tiers.medium, None);
}

#[test]
fn warns_about_an_unknown_coding_agent() {
    let (cfg, warnings) = load_with_warnings(&[("CODING_AGENT", " Gemini ")]);
    let cfg = cfg.unwrap();
    assert_eq!(cfg.configured_coding_agent, None);
    assert_eq!(cfg.coding_agent(), CodingAgentName::ClaudeCode);
    assert_eq!(
        warnings[0],
        (
            json!({ "configuredAgent": "gemini" }),
            "[Startup] invalid CODING_AGENT; using the detected default".to_string()
        )
    );
    assert_eq!(
        load(&[("CODING_AGENT", "codex")]).configured_coding_agent,
        Some(CodingAgentName::Codex)
    );
}
