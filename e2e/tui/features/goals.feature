Feature: CLI goal command
  As a user I want the /goal slash command to drive the runtime's goal REST API.
  The TUI session pins a thread at launch, so /goal works without sending a
  message first. These scenarios run the real agent loop against Bedrock. Each
  goal-creating scenario stops its goal so no background loop lingers, and the
  empty-list scenario runs first (the per-file runtime starts with no goals).

  Scenario: /goal list reports no goals initially
    When I run "/goal list"
    Then I see "No goals yet."

  Scenario: set, inspect, pause, resume, and stop a goal
    When I run "/goal Keep an ongoing watch on the project; this goal never finishes."
    Then I see "Goal set"
    When I run "/goal pause"
    Then I see "Goal paused"
    When I run "/goal"
    Then I see "Status: paused"
    When I run "/goal list"
    Then I see "[paused]"
    When I run "/goal resume"
    Then I see "Goal resumed"
    When I run "/goal stop"
    Then I see "Goal stopped"

  Scenario: /goal clear is an alias for stop
    When I run "/goal Keep an ongoing watch on the project; this goal never finishes."
    Then I see "Goal set"
    When I run "/goal clear"
    Then I see "Goal stopped"
