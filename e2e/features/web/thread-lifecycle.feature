Feature: Thread Lifecycle
  As a user I want my conversation threads to be managed correctly
  so that I see the right messages and can start fresh conversations

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Chat uses the active thread for message history
    Given I have a conversation with the following messages:
      | role  | content        |
      | USER  | first message  |
      | AGENT | first response |
    When I navigate to the agent chat page
    Then I should see the message "first message" in the conversation
    And I should see the message "first response" in the conversation

  Scenario: Deactivated thread is not shown in chat
    Given I have a deactivated conversation with the following messages:
      | role  | content      |
      | USER  | old message  |
      | AGENT | old response |
    When I navigate to the agent chat page
    Then I should not see the message "old message" in the conversation
    And I should not see the message "old response" in the conversation

  Scenario: New messages go to a new thread after deactivation
    Given I have a deactivated conversation with the following messages:
      | role  | content      |
      | USER  | old message  |
      | AGENT | old response |
    When I navigate to the agent chat page
    And I type "hello after reset" in the chat input
    And I send the message
    Then I should see my message "hello after reset" in the conversation
    And I should not see the message "old message" in the conversation

  Scenario: Slack-sourced threads are not shown in webchat
    Given I have a Slack-sourced conversation with the following messages:
      | role  | content        |
      | USER  | slack message  |
      | AGENT | slack response |
    When I navigate to the agent chat page
    Then I should not see the message "slack message" in the conversation
    And I should not see the message "slack response" in the conversation
