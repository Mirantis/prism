Feature: CLI slash-command UI
  As a user I want the slash-command popup and dispatch to work
  (Enter completes the highlighted row; a second Enter runs the command)
  (these scenarios run locally inside `prism` — no LLM call)

  Scenario: Typing a slash shows the command popup
    When I type a forward slash
    Then the popup lists the available commands
    And the first command is highlighted

  Scenario: Enter completes the highlighted command and a second Enter dispatches it
    When I type /copy and press Enter twice
    Then I see the "no message to copy" notice

  Scenario: The arrow keys move the highlight and Tab completes the command
    When I type "/he" and press the down arrow
    Then the second matching command is highlighted
    When I press Tab and then Enter
    Then I see the "/heartbeat" usage notice

  Scenario: The up arrow recalls the last line I submitted
    Given I ran the "/help" command
    When I press the up arrow in the empty composer
    Then the composer holds "/help" again
