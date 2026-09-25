Feature: Web UI in a graphical terminal
  Scenario: Use the web UI through terminal graphics and input
    Given the web UI fills a Kitty-compatible terminal
    When I move the mouse over a button and the composer
    Then the pointer changes between a hand and a text cursor
    When I paste a message and edit it with the keyboard
    Then the submitted message contains the edited text
    When I click New chat with the terminal mouse
    Then a new conversation opens
    When I resize the terminal
    Then the web UI fills the resized terminal
    When I press Ctrl+C in the graphical view
    Then the terminal modes are restored and the CLI exits successfully

  Scenario: Display the web UI when the terminal cannot read local files
    Given the terminal cannot read local frame files
    Then the web UI fills the terminal using inline images

  Scenario: Restore the terminal after a startup error
    Given the runtime is unavailable in a Kitty-compatible terminal
    Then the terminal modes are restored and the CLI reports the error
