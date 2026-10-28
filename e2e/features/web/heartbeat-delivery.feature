Feature: Where a heartbeat may post
  As a user I want to choose where the heartbeat may post, and see it post
  only what a check finds, so monitoring reaches me without noise

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The heartbeat's delivery setting is saved from the Profile page
    When I navigate to the profile page
    Then the heartbeat may post to "All channels"
    When I set the heartbeat to post to "Chat"
    Then the stored heartbeat delivery is "chat"
    When I reload the page
    Then the heartbeat may post to "Chat"

  Scenario: A heartbeat check that finds something posts it into web chat
    Given the heartbeat checks are "- Reply with exactly HEARTBEAT_FOUND_IT, as a message to me."
    And the heartbeat may post to web chat only
    When the heartbeat runs
    Then a heartbeat message reading exactly "HEARTBEAT_FOUND_IT" is shown in the conversation

  Scenario: A heartbeat with nothing to report posts nothing
    Given the heartbeat checks are "- Check whether the current year is 1999. Tell me only if it is."
    And the heartbeat may post to web chat only
    When the heartbeat runs
    Then no heartbeat message is shown in the conversation
