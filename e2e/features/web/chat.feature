Feature: Agent Chat
  As a user I want to chat with my personal agent
  so that I can get help with tasks

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Send a message and receive a response
    When I navigate to the agent chat page
    And I type "hello" in the chat input
    And I send the message
    Then I should see my message "hello" in the conversation
    And I should see an agent response in the conversation

  Scenario: Chat shows message history
    Given I have a conversation with the following messages:
      | role  | content             |
      | USER  | What is Kubernetes? |
      | AGENT | Kubernetes is...    |
    When I navigate to the agent chat page
    Then I should see the message "What is Kubernetes?" in the conversation
    And I should see the message "Kubernetes is..." in the conversation

  Scenario: Chat with Opus 5.5
    Given the chat model is "global.anthropic.claude-opus-5-5"
    When I navigate to the agent chat page
    And I type "Reply with exactly OPUS_55_OK" in the chat input
    And I send the message
    Then the agent reply contains "OPUS_55_OK"
    And no reply is an error
    And the recorded chat model is "global.anthropic.claude-opus-5-5"
    And the context indicator shows a usage percentage
    And the indicator percentage matches the stored snapshot

  Scenario: Cancel an in-progress response
    When I navigate to the agent chat page
    And I type "Write a long, detailed essay about the full history of computing." in the chat input
    And I send the message
    And I stop the in-progress response
    Then I should see the message "Response stopped" in the conversation
    And the chat composer should be ready for input again

  Scenario: Steer a response that is already in progress
    Given the shell workspace has no steering marker
    When I navigate to the agent chat page
    And I type "Use your shell to run `touch steering-started.marker && sleep 20`, then reply with exactly ALPHA." in the chat input
    And I send the message
    And the agent has started running the shell command
    And I type "Change of plan: ignore the earlier instruction. Do not output the word ALPHA. Reply with exactly BRAVO." in the chat input
    And I send the message while the agent is responding
    Then the agent reply contains "BRAVO"
    And no reply is an error
    And the thread has 2 user messages
    And no delivered agent message contains "ALPHA"
