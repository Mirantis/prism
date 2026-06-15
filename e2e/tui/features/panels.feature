Feature: CLI interactive panels
  As a user I want the /schedules and /config panels to open and operate
  (panel state is seeded and verified via the runtime's REST API)

  Scenario: /schedules opens an empty panel
    When I open the schedules panel
    Then I see "Schedules"
    And I see "No scheduled tasks"

  Scenario: /schedules lists a seeded task and deletes it via the UI
    Given a cron task "E2E Daily Report" exists
    When I open the schedules panel
    Then I see "E2E Daily Report"
    When I delete the selected task and confirm
    Then I see "No scheduled tasks"
    And no cron tasks remain

  Scenario: /schedules opens the create form
    When I open the schedules panel
    Then I see "No scheduled tasks"
    When I open the create form
    Then I see "New schedule"
    And I see "Name"
    And I see "Schedule"
    And I see "Instruction"
    And no cron tasks remain

  Scenario: /config shows identity, the focused file list, and the config docs
    When I open the config panel
    Then I see "Model"
    And I see "Files"
    And I see the config doc labels

  Scenario: Esc closes an open panel back to chat
    When I open the config panel
    Then I see "Model"
    When I press Escape
    Then the chat input is focused again
