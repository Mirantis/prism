Feature: Locked-in mode (TUI)
  As a user I want a locked agent to refuse rewriting its identity documents
  from a terminal conversation too, not only from the web.

  Scenario: The lock round-trips through the REST API
    When I set locked-in to "true"
    Then the stored locked-in flag is "true"
    When I set locked-in to "false"
    Then the stored locked-in flag is "false"

  Scenario: A locked agent leaves its soul document alone
    Given locked-in is "true"
    When I ask the agent to rewrite its soul
    Then the soul document is unchanged
