Feature: Remaining context-window indicator
  As a user I want to see how much of the model's context window a conversation
  has consumed, so a long thread doesn't silently run out of room

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The indicator appears after a turn and agrees with the stored snapshot
    Given I open a fresh chat
    Then the chat shows no context indicator
    When a chat turn completes
    Then the context indicator shows a usage percentage
    And the thread's stored context snapshot is populated
    And the indicator percentage matches the stored snapshot

  Scenario: The indicator survives a page reload
    Given I open a fresh chat
    When a chat turn completes
    And I reload the chat page
    Then the context indicator shows a usage percentage

  Scenario: No indicator is shown for a model whose window is unknown
    Given the thread has a stored snapshot for an unrecognized model
    When I reload the chat page
    Then the chat shows no context indicator
