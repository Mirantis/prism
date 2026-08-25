Feature: Editing the agent guide (TUI)
  As a user I want to edit the agent guide from the terminal, since the agent
  has no tool that can write it.

  Scenario: What the editor saved becomes the stored guide
    Given the agent guide starts as "TUI guide before."
    When I run "/agent-guide" with an editor that writes "TUI guide after GUIDETUI5X."
    Then the CLI reports the guide was saved
    And the stored agent guide is "TUI guide after GUIDETUI5X."

  Scenario: An editor that saves nothing leaves the guide alone
    Given the agent guide starts as "TUI guide before."
    When I run "/agent-guide" with an editor that changes nothing
    Then the CLI reports the guide unchanged
    And the stored agent guide is "TUI guide before."

  # Ink refcounts raw mode, so releasing it through Ink is a no-op while other
  # hooks hold it. A line-oriented editor on a raw tty gets no echo, no line
  # editing, and no Ctrl+C, so the hand-off is asserted rather than assumed.
  Scenario: The editor inherits a normal terminal
    Given the agent guide starts as "TUI guide before."
    When I run "/agent-guide" with an editor that records its terminal mode
    Then the CLI reports the guide was saved
    And the stored agent guide is "COOKED_TTY"
