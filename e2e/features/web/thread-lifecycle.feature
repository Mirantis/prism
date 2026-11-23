Feature: Thread Lifecycle
  As a user I want my conversation threads to be managed correctly
  so that I see the right messages and can start fresh conversations

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Chat uses the latest thread for message history
    Given I have a conversation with the following messages:
      | role  | content        |
      | USER  | first message  |
      | AGENT | first response |
    When I navigate to the agent chat page
    Then I should see the message "first message" in the conversation
    And I should see the message "first response" in the conversation

  Scenario: Only the latest thread is shown in chat
    Given I have an older conversation with the following messages:
      | role  | content      |
      | USER  | old message  |
      | AGENT | old response |
    And I have a conversation with the following messages:
      | role  | content         |
      | USER  | latest message  |
      | AGENT | latest response |
    When I navigate to the agent chat page
    Then I should see the message "latest message" in the conversation
    And I should not see the message "old message" in the conversation

  Scenario: Slack-sourced threads are not shown in webchat
    Given I have a Slack-sourced conversation with the following messages:
      | role  | content        |
      | USER  | slack message  |
      | AGENT | slack response |
    When I navigate to the agent chat page
    Then I should not see the message "slack message" in the conversation
    And I should not see the message "slack response" in the conversation

  Scenario: A Slack thread does not open in webchat by its address
    Given I have a stored Slack thread with the following messages:
      | role  | content              |
      | USER  | stored slack message |
      | AGENT | stored slack reply   |
    When I open that Slack thread's chat address
    Then the chat leaves that Slack thread
    And I should not see the message "stored slack message" in the conversation
    And I should not see the message "stored slack reply" in the conversation
