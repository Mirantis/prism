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

  @claude-subscription
  Scenario: Run a coding task on a saved Claude subscription
    Given I am logged in
    And I have a personal agent
    And Claude Code has a saved subscription login
    When I ask a Claude Code task how it is signed in
    Then the coding task is signed in with "claude.ai"

  # A Bedrock-ID override serves Bedrock only; on the subscription the tier
  # runs its default alias, which the claude.ai login accepts.
  @claude-subscription
  Scenario: Run a coding task on a saved Claude subscription with a model tier
    Given I am logged in
    And I have a personal agent
    And Claude Code has a saved subscription login
    And Claude Code's small model is a Bedrock ID
    When I ask a Claude Code task on the "small" model how it is signed in
    Then the coding task is signed in with "claude.ai"

  # With CODEX_SUBSCRIPTION=true the runtime holds OpenAI keys the API refuses,
  # so the task can succeed only on the saved ChatGPT login.
  @codex-subscription
  Scenario: Run a coding task on a saved ChatGPT subscription, not on the agent's OpenAI key
    Given I am logged in
    And I have a personal agent
    And Codex has a saved ChatGPT login
    And a coding task file contains "before"
    When I ask for a coding task using "codex"
    Then the coding task file contains "after"
    And the coding task used "codex"

  # A Bedrock-ID override serves Bedrock only; on the subscription the tier
  # runs its default model, which the ChatGPT login accepts.
  @codex-subscription
  Scenario: Run a coding task on a saved ChatGPT subscription with a model tier
    Given I am logged in
    And I have a personal agent
    And Codex has a saved ChatGPT login
    And Codex's small model is a Bedrock ID
    And a coding task file contains "before"
    When I ask for a coding task using "codex" on the "small" model
    Then the coding task file contains "after"
    And the coding task used "codex"
    And the coding task asked for the "small" model
