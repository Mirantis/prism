Feature: Remaining context window in the status bar
  As a user I want the status bar to tell me how much context the conversation
  has used, so a long session doesn't silently run out of room

  Scenario: The status bar shows context used after a turn
    Given a fresh CLI session
    Then the status bar shows no context percentage yet
    When I send a message and the turn completes
    Then the status bar shows a context percentage
    And the thread's context snapshot is recorded in the database
    And the threads endpoint reports the same snapshot

  Scenario: A resumed session shows the last known percentage
    Given a fresh CLI session
    When I send a message and the turn completes
    And I resume the session in a new CLI
    Then the status bar shows a context percentage
