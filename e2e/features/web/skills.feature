Feature: Skills slash command (web)
  As a user I want to discover and run installed skills from the web chat with
  a "/" slash command. This suite covers listing and running a global skill,
  so the CLI suite keeps the `list` alias and the unknown-skill path, which
  only the CLI parses.

  Background:
    Given I am logged in
    And I have a personal agent

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
