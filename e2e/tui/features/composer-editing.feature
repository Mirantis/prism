Feature: CLI composer editing keys
  As a user I want the composer to move by row, line and word, and to walk my
  message history without losing the draft I was typing

  Scenario: Row, line and word keys edit a two-line draft
    When I type "alpha beta gamma" and "delta epsilon" on two lines
    And I edit the draft with Up, Option+Left, Home, Ctrl+E, Down, Meta+B, Ctrl+Left and Ctrl+A
    And I press Enter
    Then the runtime stores "Halpha beta WgammaE\nAdelta CMepsilon"

  Scenario: Up moves to the first row of a wrapped line
    When I type a line that wraps onto a second row
    And I press Up and type "U"
    And I press Enter
    Then the runtime stores the line with "U" on its first row

  Scenario: Up recalls history from a draft and Down brings the draft back
    Given I have sent "first message"
    When I type "my draft", press Up and press Enter
    Then the runtime stores "first message" a second time
    When I type "second draft", press Up and press Down
    And I type " kept" and press Enter
    Then the runtime stores "second draft kept"

  Scenario: The popup takes Up and Down, except while I walk history
    Given I have run "/copy"
    When I type a forward slash and press Down
    Then the popup highlights a command other than /copy
    When I clear the composer, type "kept draft", press Up and press Down
    And I press Enter
    Then the runtime stores "kept draft"
