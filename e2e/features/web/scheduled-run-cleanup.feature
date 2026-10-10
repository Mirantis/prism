Feature: A scheduled run manages the schedule
  As a user I want a scheduled task to read the schedule and delete tasks,
  its own task included, so the agent can remove follow-ups it does not need.

  Background:
    Given I am logged in
    And I have a personal agent

  # @slow: a chat turn, the 20-second wait, then a scheduled run of three model calls.
  @slow
  Scenario: A scheduled run deletes another task and itself, then delivers its reply
    When I navigate to the agent chat page
    And I type "Use your schedule_task tool to schedule two one-off tasks. First: name 'spare-check', schedule 'in 30 minutes', instruction 'Reply with exactly SPARE_RAN and nothing else.'. Second: name 'tidy-up', schedule 'in 20 seconds', instruction 'Call list_scheduled_tasks. Then call delete_scheduled_task for the task named spare-check and for the task named tidy-up. Then reply with exactly TIDY_UP_OK and nothing else.'. Then briefly tell me you've scheduled both." in the chat input
    And I send the message
    Then the scheduled tasks named "spare-check" and "tidy-up" are created for the agent
    And a scheduled-task message containing "TIDY_UP_OK" is delivered
    And the run that delivered "TIDY_UP_OK" deleted the tasks named "spare-check" and "tidy-up"
