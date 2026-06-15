Feature: CLI tool-call expansion
  As a user I want to expand and collapse a tool call the agent made
  with Ctrl+O, without the keypress leaking into the input

  Scenario: Ctrl+O expands the latest tool call and again collapses it
    When I ask the agent to run a shell command echoing "prism-toolcall"
    Then the tool-call row can be expanded
    When I press Ctrl+O
    Then the tool call input and output are shown
    And the tool-call row can be collapsed
    When I press Ctrl+O again
    Then the tool-call row is collapsed again
