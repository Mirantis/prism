Feature: Plugins
  Installed Agent Plugins (the agent-plugins.org standard) contribute skills and
  MCP tool servers. `/plugins` lists them with what each contributes, a plugin's
  skill shows up in `/skills` labelled with its plugin, and a malformed plugin is
  skipped with an attributable reason instead of taking the agent down. Listing
  is deterministic; running the plugin's skill goes through the real
  conversation engine (Bedrock).

  Scenario: /plugins lists an installed plugin and what it contributes
    When I run "/plugins"
    Then I see "demo v1.2.0"
    And I see "A demo plugin"
    And I see "skills: plugin-marker"

  Scenario: /plugins reports a plugin that failed to load its MCP servers
    When I run "/plugins"
    Then I see "half-broken"
    And I see "single token"

  Scenario: a plugin skill appears in /skills labelled with its plugin
    When I run "/skills"
    Then I see "plugin-marker"
    And I see "(plugin: demo)"

  Scenario: a broken plugin does not stop a healthy one
    When I run "/plugins"
    Then I see "demo"
    And I do not see "bad-version"

  Scenario: the agent can run a skill contributed by a plugin
    When I run "/skills run plugin-marker"
    Then I see "PLUGIN_SKILL_RAN_OK"

  Scenario: /plugins reports the MCP server the plugin contributes
    When I run "/plugins"
    Then I see "mcp servers: probe"

  Scenario: the agent can call a tool from a plugin's stdio MCP server
    When I run "Call the demo__probe__plugin_mcp_probe tool and reply with exactly what it returns, nothing else."
    Then I see "PLUGIN_MCP_TOOL_OK"
