Feature: A restart continues the agent's work
  As a user I want the reply the agent was working on
  even when the runtime is killed in the middle of it

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The runtime is killed while the agent runs a command
    Given the shell workspace has no restart marker
    When I navigate to the agent chat page
    And I type "Use your shell to run `touch restart-started.marker && sleep 20`, then reply with exactly RESTARTED-OK." in the chat input
    And I send the message
    And the agent has started running the long command
    And the runtime is killed and starts again
    Then the open conversation shows the agent reply "RESTARTED-OK"
    And no reply is an error
    And the agent owes no reply
