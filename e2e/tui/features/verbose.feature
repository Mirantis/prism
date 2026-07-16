Feature: Verbose / concise delivery mode (TUI)
  As a user I want concise mode to deliver only the final response in the TUI

  Scenario: Concise mode shows one response block but DB has multiple AGENT rows
    Given verbose is false
    When I send a multi-step prompt
    Then the TUI shows one agent response block
    And the database has more than one AGENT message

  Scenario: Verbose mode streams all intermediate steps
    Given verbose is true
    When I send a multi-step prompt
    Then the TUI shows multiple agent response blocks
