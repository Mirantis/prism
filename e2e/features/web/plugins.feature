Feature: Plugins slash command (web)
  As a user I want to see which Agent Plugins are installed and what each one
  contributes, from the web chat. The CLI suite keeps the malformed-plugin
  cases and the MCP servers, which need fixtures the web suite does not
  install.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: /plugins lists the installed plugin and what it contributes
    When I navigate to the agent chat page
    And I type "/plugins" in the chat input
    And I send the message
    Then I should see the message "demo v1.2.0" in the conversation

  Scenario: A plugin skill is listed with its plugin
    When I navigate to the agent chat page
    And I type "/skills" in the chat input
    And I send the message
    Then I should see the message "(plugin: demo)" in the conversation

  Scenario: The agent runs a skill contributed by a plugin
    When I navigate to the agent chat page
    And I type "/skills run plugin-marker" in the chat input
    And I send the message
    Then I should see the message "PLUGIN_SKILL_RAN_OK" in the conversation
