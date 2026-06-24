Feature: Waiting — continue a scheduled task in the same thread
  As a user I want the agent to "wait" for something and resume here
  so that the follow-up lands in this conversation, not a brand-new thread.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A one-off task scheduled with continueInThread resumes in the same thread
    When I navigate to the agent chat page
    And I type "Use your schedule_task tool to WAIT and then continue in THIS same conversation. Schedule a one-off task: name 'recheck', schedule 'in 1 minute', continueInThread set to true, instruction 'Reply with exactly WAIT_RESUMED_OK and nothing else.'. Then briefly tell me you've scheduled it." in the chat input
    And I send the message
    Then a thread-bound scheduled task is created for the agent
    And the agent posts a follow-up in that same thread when the task fires
