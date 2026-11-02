@tool-search
Feature: MCP tools loaded on demand
  As the owner of an agent with many MCP tools I want the agent to load a tool's
  definition only when it needs it so that a turn does not pay for every tool

  Background:
    Given I am logged in
    And I have a personal agent
    And the agent loads its MCP tools on demand

  # The demo plugin's MCP tool answers a marker the agent can only learn by
  # calling it. The second turn calls it again without loading it.
  Scenario: The agent loads an MCP tool and calls it again in the next turn
    When I navigate to the agent chat page
    And I type "Load the tool demo__probe__plugin_mcp_probe, call it, and reply with one line only: FIRST=<what it returned>." in the chat input
    And I send the message
    Then the agent reply contains "FIRST=PLUGIN_MCP_TOOL_OK"
    And no reply is an error
    And the stored tool calls include "load_tools" and "demo__probe__plugin_mcp_probe"
    When I type "The tool demo__probe__plugin_mcp_probe is still loaded. Call it once more without loading anything, and reply with one line only: SECOND=<what it returned>." in the chat input
    And I send the message
    Then the agent reply contains "SECOND=PLUGIN_MCP_TOOL_OK"
    And no reply is an error
    And the stored tool calls include "load_tools" 1 time and "demo__probe__plugin_mcp_probe" 2 times
