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

  Scenario: A task's name, schedule and instruction can be edited
    When I navigate to the scheduled tasks page
    And I create the task "Weekday standup" with the "Weekdays at 09:00" schedule
    And I edit the task "Weekday standup" to "Monday plan" with the "Mondays at 09:00" schedule and the instruction "Post the plan for the week."
    And I navigate to the scheduled tasks page
    Then the task "Monday plan" is listed as "Mondays at 09:00" with the expression "0 9 * * 1"
    And the task "Monday plan" has the instruction "Post the plan for the week."
    And the task "Weekday standup" is not listed

  Scenario: A task's delivery target can be chosen and changed
    When I navigate to the scheduled tasks page
    And I start the task "Chat digest" with the "Weekdays at 09:00" schedule
    And I give the new task the instruction "Post a short digest."
    And I choose "Chat" as the new task's delivery target and schedule it
    Then the task "Chat digest" delivers to "Chat"
    When I change the delivery target of the task "Chat digest" to "All channels"
    Then the task "Chat digest" names no delivery target

  Scenario: A task that delivers nowhere runs and posts nothing
    Given a one-off scheduled task "nowhere-check" in 20 seconds that delivers to "none" with the instruction "Use your memory_write tool to store a memory with the exact content NOWHERE_CHECK_RAN. Then reply with exactly NOWHERE_CHECK_DONE and nothing else."
    Then a scheduled task named "nowhere-check" is created for the agent
    And the scheduled task named "nowhere-check" runs to completion
    And the quiet task has written "NOWHERE_CHECK_RAN" to memory
    And no scheduled-task message is delivered after the quiet task was created

  Scenario: The agent edits a task when asked in chat
    When I navigate to the scheduled tasks page
    And I create the task "Weekday standup" with the "Weekdays at 09:00" schedule
    And I navigate to the agent chat page
    And I type "Move my Weekday standup task to Mondays at 9am." in the chat input
    And I send the message
    Then the agent changed the task with update_scheduled_task
    And the chat composer should be ready for input again
    When I navigate to the scheduled tasks page
    Then the task "Weekday standup" is listed as "Mondays at 09:00" with the expression "0 9 * * 1"
    And the task "Weekday standup" has the instruction "Post a short standup summary."
