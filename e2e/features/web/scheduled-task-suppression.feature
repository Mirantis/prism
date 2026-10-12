Feature: Scheduled tasks stay silent when there is nothing to report
  As a user I want a conditional scheduled task to post only when its
  condition is met, so periodic checks don't spam my conversation.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: An unconditional task always delivers its result
    When I navigate to the agent chat page
    And I type "Use your schedule_task tool to schedule a one-off task: name 'deliver-check', schedule 'in 20 seconds', instruction 'Reply with exactly CRON_DELIVERY_OK and nothing else.'. Then briefly tell me you've scheduled it." in the chat input
    And I send the message
    Then a scheduled task named "deliver-check" is created for the agent
    And a scheduled-task message containing "CRON_DELIVERY_OK" is delivered

  Scenario: A conditional task with nothing to report stays silent
    When I navigate to the agent chat page
    And I type "Use your schedule_task tool to schedule a one-off task: name 'quiet-check', schedule 'in 20 seconds', instruction 'Use your memory_write tool to store a memory with the exact content QUIET_CHECK_RAN. Then check whether the current year is 1999. Only send me a message if it is 1999; otherwise there is nothing to report.'. Then briefly tell me you've scheduled it." in the chat input
    And I send the message
    Then a scheduled task named "quiet-check" is created for the agent
    And the scheduled task named "quiet-check" runs to completion
    And the quiet task has written "QUIET_CHECK_RAN" to memory
    And no scheduled-task message is delivered after the quiet task was created

  Scenario: A conditional task reports a finding once, not on every run
    # Each run reads the clock, so the same finding comes back in other words.
    Given a recurring scheduled task "repeat-check" every 30 seconds with the instruction "Run the shell command date -u +%T. Then check whether 7 is a prime number. Only send me a message if it is: start it with REPEAT_CHECK_FOUND, then give the time the command printed."
    When the recurring task has run 3 times
    Then exactly 1 scheduled-task message is delivered after the recurring task was created
