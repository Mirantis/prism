Feature: Tool risk gate (TUI)
  As an operator running the gate in enforce mode I want ordinary work to carry
  on untouched.

  Scenario: Ordinary work still runs under enforce mode
    Given my agent guide states no policy
    When I ask the agent to write a note in its workspace
    Then the note exists in the workspace
    And the risk gate evaluated the call
