Feature: Workspace layout
  As a user I want the workspace to stay usable with a keyboard and on a phone

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The first Tab press offers a skip link into the content
    When I open the overview at desktop size
    And I press Tab once
    Then the skip link is focused
    When I press Enter
    Then the main content is focused

  Scenario: The phone menu closes after picking a page
    When I open the overview at phone size
    And I pick "Chat" from the phone menu
    Then the phone menu is closed
    And the URL is the "/chat" page

  Scenario Outline: Pages fit a phone screen without sideways scrolling
    When I open "<path>" at phone size
    Then the page fits the screen width
    Examples:
      | path      |
      | /         |
      | /chat     |
      | /profile  |
      | /channels |
      | /cron     |
      | /webhooks |
      | /activity |

  Scenario: A long Recents list gets a filter box
    Given 6 conversation threads titled after "Project"
    When I navigate to the agent chat page
    Then the Recents filter is shown
    When I filter Recents by "Project 3"
    Then the Recents list has 1 conversation
    And the Recents list shows "Project 3"
    When I filter Recents by "nothing like this"
    Then Recents says that no conversation matches
    When I clear the Recents filter
    Then the Recents list has 6 conversations

  Scenario: The agent's mark shows when it is working
    Given the shell workspace has no steering marker
    When I navigate to the agent chat page
    And I start a new conversation from the sidebar
    Then the agent presence reads "IDLE"
    Given a second tab is open on a new conversation
    When I type "Use your shell to run `touch steering-started.marker && sleep 12`, then reply with exactly DONE." in the chat input
    And I send the message
    And the agent has started running the shell command
    Then the agent presence reads "RUNNING"
    And the second tab shows the agent working and no response of its own in progress
    When I should see an agent response in the conversation
    Then the agent presence reads "IDLE"
    And the second tab is closed

  Scenario: A short Recents list has no filter box
    Given a conversation thread rooted at "/work/project-one"
    When I navigate to the agent chat page
    Then the Recents list has 1 conversation
    And the Recents filter is hidden
