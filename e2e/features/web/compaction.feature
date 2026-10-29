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

  Scenario: The agent reads a detail the summary replaced
    Given a conversation seeded with 10 messages
    When I type "/compact" in the chat input
    And I send the message
    And the compaction note appears in the conversation
    And I type "Read the compacted history: which port did my very first message give for service-0?" in the chat input
    And I send the message
    Then the agent reply contains "3000"
    And the agent read the compacted history

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
