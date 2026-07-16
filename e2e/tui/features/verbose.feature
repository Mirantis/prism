Feature: Verbose / concise delivery mode (TUI)
  As a user I want concise mode to deliver only the final response in the TUI

  Scenario: Concise mode delivers only the final message but persists every step
    Given verbose is false
    When I send a multi-step prompt
    Then the intermediate narration is not shown in the TUI
    And the database has more than one AGENT message

  Scenario: Verbose mode delivers the intermediate narration too
    Given verbose is true
    When I send a multi-step prompt
    Then the intermediate narration is shown in the TUI
    And the database has more than one AGENT message
