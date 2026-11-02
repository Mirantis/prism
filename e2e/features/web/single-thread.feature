@single-thread
Feature: One conversation
  As the owner of an agent that keeps one conversation I want every client to open it
  so that my messages and the agent's own work share one history

  Background:
    Given I am logged in
    And I have a personal agent
    And the agent keeps one conversation

  Scenario: The pages offer no way to start or switch a conversation
    Given an older conversation thread rooted at "/work/project-one" containing "hello from project one"
    And a conversation thread with no workspace root
    When I navigate to the agent chat page
    Then I should see the message "hello from project one" in the conversation
    And the sidebar offers no new chat and no Recents list
    When I open the command palette
    Then the command palette offers no new chat and no conversations
    When I navigate to the overview page
    Then the overview lists no conversations

  Scenario: A request for a new conversation returns the one there is
    Given an older conversation thread rooted at "/work/project-one" containing "hello from project one"
    When a client asks the runtime for a new conversation
    Then the runtime answers with the conversation holding "hello from project one"
    And the runtime lists that conversation alone
    And the database holds 1 conversation thread

  Scenario: A voice call continues the one conversation
    Given an older conversation thread rooted at "/work/project-one" containing "The rollout codename is MAPLEKESTREL4"
    And the voice model has heard nothing yet
    When I navigate to the agent chat page
    Then I should see the message "The rollout codename is MAPLEKESTREL4" in the conversation
    When I start a voice chat from the chat header
    Then the chat shows the call is live
    And the voice session opened with the conversation holding "User: The rollout codename is MAPLEKESTREL4"
    When I end the voice chat
    Then the voice model has no session open
