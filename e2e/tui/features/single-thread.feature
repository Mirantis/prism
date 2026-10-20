Feature: An agent that keeps one conversation
  As a user of an agent in single-thread mode I want the CLI to open its one conversation
  so that I continue where every client left off

  Scenario: The CLI opens the conversation with its history
    Given the agent's conversation holds "single-thread-history-marker"
    When I launch the CLI
    Then the CLI shows "single-thread-history-marker"
    And the agent still has one conversation

  Scenario: --resume opens the conversation without a picker
    Given the agent's conversation holds "single-thread-resume-marker"
    When I launch the CLI with --resume
    Then the CLI shows "single-thread-resume-marker"
    And the CLI showed no resume picker
    And the agent still has one conversation
