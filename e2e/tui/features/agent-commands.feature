Feature: CLI management commands
  As a user I want the management slash commands to drive the runtime's
  /agents/* REST API (none of these call the LLM)

  Scenario: /help lists the management commands with descriptions
    When I run "/help"
    Then I see "Manage scheduled cron tasks"
    And I see "Control the heartbeat"

  Scenario: /rename updates the agent name preserving spaces
    When I run "/rename E2E Renamed Bot"
    Then the rename to "E2E Renamed Bot" is confirmed
    And the stored agent name is "E2E Renamed Bot"

  Scenario: /model sets then resets the model override
    Given the agent starts on its default model
    When I run "/model my-test-model"
    Then the model is set to "my-test-model"
    And the stored model is "my-test-model"
    When I reset the model to its default
    Then the model is set back to the default
    And the stored model is the default

  Scenario: /heartbeat-model sets then resets the heartbeat model override
    When I run "/heartbeat-model hb-test-model"
    Then the heartbeat model is set to "hb-test-model"
    When I run "/heartbeat-model reset"
    Then the heartbeat model is cleared to the main model

  Scenario: /cron-model sets then resets the scheduled-task model override
    When I run "/cron-model cron-test-model"
    Then the cron model is set to "cron-test-model"
    When I run "/cron-model reset"
    Then the cron model is cleared to the main model

  Scenario: /model-mode switches between Auto and Fixed
    Given the agent has no Auto models
    When I run "/model-mode"
    Then I see "Model mode is fixed."
    When I run "/model-mode auto"
    Then I see "Auto mode needs a small and a large model"
    And the agent stays in Fixed mode
    When the agent is given a small and a large model
    And I run "/model-mode auto"
    Then I see "Model mode set to auto: small tui-small-model, large tui-large-model."
    And the agent is in Auto mode
    When I run "/model-mode fixed"
    Then I see "Model mode set to fixed."
    And the agent is back in Fixed mode

  Scenario: /heartbeat status reports the current state
    When I run "/heartbeat status"
    Then I see "active:"
    And I see "interval:"

  Scenario: /heartbeat stop then start toggles isActive
    When I run "/heartbeat stop"
    Then I see "Heartbeat stopped"
    And the heartbeat is inactive
    When I run "/heartbeat start"
    Then I see "Heartbeat started"
    And the heartbeat is active

  Scenario: /heartbeat every 5m updates the interval
    When I run "/heartbeat every 5m"
    Then I see "Heartbeat interval set to 300000ms."
    And the heartbeat interval is 300000 ms

  Scenario: /heartbeat with an unknown subcommand shows usage
    When I run "/heartbeat wat"
    Then I see "Usage: /heartbeat"
