Feature: Manual conversation compaction
  As a user I want to fold older history into a summary with /compact, so a
  long conversation keeps fitting in the model's context window without losing
  what was decided

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: /compact summarizes older history and keeps the tail
    Given a conversation seeded with 10 messages
    When I type "/compact" in the chat input
    And I send the message
    Then the compacting indicator appears
    And the compaction note appears in the conversation
    And the thread stores a compaction summary with the tail preserved
    And a manual compaction telemetry event is recorded

  Scenario: The agent reads a detail the summary left out
    Given a compacted conversation whose summary leaves out the build id from a deploy log
    When I type "What was the build id in the deploy log you read earlier?" in the chat input
    And I send the message
    Then the agent reply contains "bld-7f3a9c2e"
    And the agent read the compacted history

  Scenario: The agent reads a long compacted message in full
    Given a compacted conversation whose summary leaves out three warnings spread through a deploy log
    When I type "List the step numbers of every warning in the deploy log you read earlier." in the chat input
    And I send the message
    Then the agent reply contains "41"
    And the agent reply contains "212"
    And the agent reply contains "377"
    And the agent read a compacted message in full

  Scenario: The full history stays visible after compaction
    Given a conversation seeded with 10 messages
    When I type "/compact" in the chat input
    And I send the message
    And the compaction note appears in the conversation
    And I reload the chat page
    Then every seeded message is still visible in the conversation

  Scenario: /compact on an empty conversation reports there is nothing to do
    Given I open a fresh chat
    When I type "/compact" in the chat input
    And I send the message
    Then I should see the message "Nothing to compact yet." in the conversation
