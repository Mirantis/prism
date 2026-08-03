Feature: Skills slash command (web)
  As a user I want to discover and run installed skills from the web chat
  using a "/" slash command with autocomplete, mirroring the CLI.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Typing "/" shows the command popup
    When I navigate to the agent chat page
    And I type "/" in the chat input
    Then I should see the command popup
    And the command popup should list "/skills"
    And the command popup should list "/help"

  Scenario: Tab autocompletes the highlighted command
    When I navigate to the agent chat page
    And I type "/sk" in the chat input
    And I press Tab in the chat input
    Then the chat input should contain "/skills"

  Scenario: /skills lists installed skills
    When I navigate to the agent chat page
    And I type "/skills" in the chat input
    And I send the message
    Then I should see the message "echo-marker" in the conversation

  Scenario: /skills run executes a skill and the agent follows it
    When I navigate to the agent chat page
    And I type "/skills run echo-marker" in the chat input
    And I send the message
    And I wait for the agent to finish responding
    Then I should see the message "SKILL_RAN_OK" in the conversation
