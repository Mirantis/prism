Feature: Application Navigation
  As a user I want to navigate between pages in the application

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Chat page shows agent name and chat input
    When I navigate to the agent chat page
    Then I should see the agent name
    And the chat input should be visible

  Scenario: Profile page shows agent info
    When I navigate to the profile page
    Then I should see the agent name
    And I should see the heartbeat status
