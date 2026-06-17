Feature: Recents conversation list
  As a user I want to see my recent conversations in the Chat sidebar
  so that I know which conversations exist

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Recents lists conversations newest-first and highlights the current one
    Given an older conversation thread rooted at "/work/project-one"
    And a conversation thread rooted at "/work/project-two"
    When I navigate to the agent chat page
    Then the Recents list shows "project-two" above "project-one"
    And the "project-two" conversation is highlighted as current
    And the "project-one" conversation is not highlighted

  Scenario: A titled thread is shown by its title, not its folder
    Given a conversation thread titled "keuruun saha translat..." rooted at "/work/ignored-folder"
    When I navigate to the agent chat page
    Then the Recents list shows "keuruun saha translat..."
    And the Recents list does not show "ignored-folder"

  Scenario: Recents excludes Slack-sourced threads
    Given a conversation thread rooted at "/work/project-db"
    And a Slack conversation thread
    When I navigate to the agent chat page
    Then the Recents list shows "project-db"
    And the Recents list has 1 conversation

  Scenario: A folder-less thread is still listed (date fallback)
    Given a conversation thread with no workspace root
    When I navigate to the agent chat page
    Then the Recents list has 1 conversation

  Scenario: The first message titles the current conversation live
    When I navigate to the agent chat page
    And I type "deploy the staging cluster" in the chat input
    And I send the message
    And I should see an agent response in the conversation
    Then the Recents list shows "deploy the staging"

  Scenario: Clicking a Recents row opens that thread
    Given an older conversation thread rooted at "/work/project-one" containing "hello from project one"
    And a conversation thread rooted at "/work/project-two"
    When I navigate to the agent chat page
    And I click the "project-one" conversation in Recents
    Then the URL is a chat thread URL
    And I should see the message "hello from project one" in the conversation
    And the "project-one" conversation is highlighted as current
    And the "project-two" conversation is not highlighted

  Scenario: Recents is only visible on the Chat page
    Given a conversation thread rooted at "/work/project-db"
    When I navigate to the agent chat page
    Then the Recents header is visible
    When I navigate to the profile page
    Then the Recents header is hidden
