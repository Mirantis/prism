Feature: CLI slash-command UI
  As a user I want the slash-command popup and direct dispatch to work
  (these scenarios run locally inside prism-cli — no LLM call)

  Scenario: Typing a slash shows the command popup
    When I type a forward slash
    Then the popup lists the available commands
    And the first command is highlighted

  Scenario: Typing a command name and Enter dispatches it
    When I submit the /copy command
    Then I see the "no message to copy" notice
