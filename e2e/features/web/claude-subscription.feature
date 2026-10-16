@claude-subscription
Feature: Claude subscription inference
  Scenario: The main agent executes a Prism tool using a Claude subscription
    Given the main agent uses a saved Claude subscription
    And I am logged in
    And I have a personal agent
    And the chat model is "sonnet"
    When I navigate to the agent chat page
    And I type "Use shell_exec to run printf SUBSCRIPTION_TOOL_OK and reply with exactly its stdout." in the chat input
    And I send the message
    Then the agent reply contains "SUBSCRIPTION_TOOL_OK"
    And no reply is an error
    And the subscription conversation used the Prism shell tool
