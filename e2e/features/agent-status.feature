Feature: Agent Status
  As a user I want to see my agent's status
  so that I know its current state

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Agent returns to Idle after processing a chat message
    When I navigate to the agent chat page
    Then I should see the agent status as "Idle"
    When I type "hello" in the chat input
    And I send the message
    And I should see an agent response in the conversation
    When I reload the page
    Then I should see the agent status as "Idle"
