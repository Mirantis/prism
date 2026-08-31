Feature: CLI slash-command UI
  As a user I want the slash-command popup and dispatch to work
  (Enter completes the highlighted row; a second Enter runs the command)
  (these scenarios run locally inside prism-cli — no LLM call)

  Scenario: Typing a slash shows the command popup
    When I type a forward slash
    Then the popup lists the available commands
    And the first command is highlighted

  Scenario: Enter completes the highlighted command and a second Enter dispatches it
    When I type /copy and press Enter twice
    Then I see the "no message to copy" notice
