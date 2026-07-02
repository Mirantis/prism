Feature: Concise vs verbose chat delivery
  As a user I want concise responses by default
  so that multi-step turns don't flood the chat with intermediate narration

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Concise by default — a multi-step turn produces one message with the tool trail
    When I navigate to the agent chat page
    And I send a prompt that forces two tool steps with narration
    Then the response completes with exactly 1 agent message
    And the agent message shows a tool-call trail

  Scenario: Toggling verbose responses on the Profile page persists
    When I navigate to the profile page
    And I turn verbose responses on
    Then the stored verbose setting is true

  # Note: verbose per-step streaming isn't asserted end-to-end here — the number
  # of delivered messages is model-controlled (a real model may answer a
  # multi-step turn in a single text step even in verbose mode), so a count
  # assertion would be flaky. That branching is covered deterministically by the
  # ConversationEngineService unit tests.
