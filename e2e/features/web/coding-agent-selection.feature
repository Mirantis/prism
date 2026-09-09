Feature: Coding agent delegation
  Scenario: Plan and resume a coding task with model and effort selection
    Given I am logged in
    And I have a personal agent
    And a coding task file contains "before"
    When I ask the coding agent to plan a change
    Then the coding task file contains "before"
    When I ask the coding agent to implement its plan
    Then the coding task file contains "after"
    And the coding task completed through delegation

  Scenario Outline: Select a coding agent for one task
    Given I am logged in
    And I have a personal agent
    And both coding agents have test credentials
    And a coding task file contains "before"
    When I ask for a coding task using "<agent>"
    Then the coding task file contains "after"
    And the coding task used "<agent>"

    Examples:
      | agent       |
      | claude-code |
      | codex       |

  @codex-login
  Scenario: Run a coding task with a saved Codex login
    Given I am logged in
    And I have a personal agent
    And Codex has a saved test login
    And a coding task file contains "before"
    When I ask for a coding task using "codex"
    Then the coding task file contains "after"
    And the coding task used "codex"
