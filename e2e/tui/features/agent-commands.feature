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
