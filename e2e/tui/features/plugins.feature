Feature: Plugins
  Installed Agent Plugins (the agent-plugins.org standard) contribute skills and
  MCP tool servers. `e2e/features/web/plugins.feature` asserts a healthy
  plugin's name and version and runs its skill. What is left here is the
  contribution lines `/plugins` prints, a malformed plugin, which the web suite
  does not install and the runtime skips with an attributable reason instead
  of stopping the agent, and the agent's own call of a tool from a real stdio
  MCP server.

  Scenario: /plugins reports what the plugin contributes
    When I run "/plugins"
    Then I see "A demo plugin"
    And I see "skills: plugin-marker"
    And I see "mcp servers: probe"

  Scenario: /plugins reports a plugin that failed to load its MCP servers
    When I run "/plugins"
    Then I see "half-broken"
    And I see "single token"

  Scenario: a broken plugin does not stop a healthy one
    When I run "/plugins"
    Then I see "demo"
    And I do not see "bad-version"

  Scenario: the agent can call a tool from a plugin's stdio MCP server
    When I run "Call the demo__probe__plugin_mcp_probe tool and reply with exactly what it returns, nothing else."
    Then I see "PLUGIN_MCP_TOOL_OK"
