Feature: Scheduled tasks page
  As a user I want to schedule recurring agent runs from the web UI
  without writing a cron expression by hand

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A schedule preset fills in the cron expression
    When I navigate to the scheduled tasks page
    Then the new task form reads schedules in the agent's time zone "UTC"
    When I create the task "Weekday standup" with the "Weekdays at 09:00" schedule
    Then the task "Weekday standup" is listed as "Weekdays at 09:00" with the expression "0 9 * * 1-5"
    And the task "Weekday standup" is active
    And the task "Weekday standup" shows its next run
    When I delete the task "Weekday standup"
    Then no scheduled task is listed

  Scenario: A task needs an instruction before it can be scheduled
    When I navigate to the scheduled tasks page
    And I start the task "Morning summary" with the "Weekdays at 09:00" schedule
    Then the Schedule button is disabled
    When I give the new task the instruction "Summarize my inbox"
    Then the Schedule button is enabled
