Feature: Monitors
  As a user I want the agent to watch something for me
  so that it tells me the moment it happens, without a timer

  Background:
    Given I am logged in
    And I have a personal agent
    And the agent is in verbose mode

  # @slow: two model turns around a line the test writes once the watch runs.
  @slow
  Scenario: A monitor reports a line the moment it appears
    Given the workspace has an empty file "monitor-e2e.log"
    When I navigate to the agent chat page
    And I type "Watch monitor-e2e.log in the workspace and, as soon as a line with ERROR in it appears, tell me that whole line." in the chat input
    And I send the message
    Then the chat composer should be ready for input again
    And the agent started a monitor
    When the line "ERROR disk quota exceeded MON-7731" is appended to "monitor-e2e.log"
    Then an agent reply after the task notification contains "MON-7731" within 60 seconds
    And no reply is an error
