Feature: Recents conversation list
  As a user I want to see my recent conversations in the Chat sidebar
  so that I know which conversations exist

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Recents lists conversations newest-first by folder name
    Given an older conversation thread rooted at "/work/project-one"
    And a conversation thread rooted at "/work/project-two"
    When I navigate to the agent chat page
    Then the Recents list shows "project-two" above "project-one"

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

  Scenario: Recents is only visible on the Chat page
    Given a conversation thread rooted at "/work/project-db"
    When I navigate to the agent chat page
    Then the Recents header is visible
    When I navigate to the profile page
    Then the Recents header is hidden
