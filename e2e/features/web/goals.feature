Feature: Background goals
  As a user I want to set a goal in natural language or with the /goal slash
  command so that the agent keeps working toward it autonomously across turns.
  The slash-command scenarios mirror the TUI's goals.feature against the same
  goal REST API; each goal-creating scenario stops its goal so no background
  loop lingers, and the empty-list scenario relies on the per-scenario DB reset.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Natural language sets a background goal that runs autonomously
    When I navigate to the agent chat page
    And I type "Please set yourself a goal and pursue it autonomously across multiple turns until it is done: write a short haiku about Kubernetes, then refine it once, then the goal is complete." in the chat input
    And I send the message
    Then a goal is created for the agent
    And the agent runs at least one autonomous goal turn
    And the goal reaches a terminal status

  Scenario: The /goal slash command is offered in the command popup
    When I navigate to the agent chat page
    And I type "/" in the chat input
    Then I should see the command popup
    And the command popup should list "/goal"

  Scenario: Tab autocompletes the /goal command
    When I navigate to the agent chat page
    And I type "/go" in the chat input
    And I press Tab in the chat input
    Then the chat input should contain "/goal"

  Scenario: /goal list reports no goals initially
    When I navigate to the agent chat page
    And I type "/goal list" in the chat input
    And I send the message
    Then I should see the message "No goals yet" in the conversation

  Scenario: /goal with no active goal reports it
    When I navigate to the agent chat page
    And I type "/goal" in the chat input
    And I send the message
    Then I should see the message "No active goal in this conversation" in the conversation

  Scenario: set, inspect, pause, resume, and stop a goal
    When I navigate to the agent chat page
    And I type "/goal Keep an ongoing watch on the project; this goal never finishes." in the chat input
    And I send the message
    Then I should see the message "Goal set" in the conversation
    When I type "/goal pause" in the chat input
    And I send the message
    Then I should see the message "Goal paused" in the conversation
    When I type "/goal" in the chat input
    And I send the message
    Then I should see the message "Status: paused" in the conversation
    When I type "/goal list" in the chat input
    And I send the message
    Then I should see the message "[paused]" in the conversation
    When I type "/goal resume" in the chat input
    And I send the message
    Then I should see the message "Goal resumed" in the conversation
    When I type "/goal stop" in the chat input
    And I send the message
    Then I should see the message "Goal stopped" in the conversation

  Scenario: /goal clear is an alias for stop
    When I navigate to the agent chat page
    And I type "/goal Keep an ongoing watch on the project; this goal never finishes." in the chat input
    And I send the message
    Then I should see the message "Goal set" in the conversation
    When I type "/goal clear" in the chat input
    And I send the message
    Then I should see the message "Goal stopped" in the conversation
