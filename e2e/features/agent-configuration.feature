Feature: Agent Configuration
  As a user I want to view and edit my agent's configuration

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: View agent properties
    When I navigate to the agent detail page
    Then I should see the agent stat cards
    And I should see the agent type badge
    And I should see the heartbeat status

  Scenario: View profile tabs
    When I navigate to the agent detail page
    Then I should see profile tabs for "Agent", "Soul", "User", "Heartbeat", "Memory"

  Scenario: Default heartbeat interval is 8 hours
    When I navigate to the agent detail page
    Then I should see the heartbeat interval "Every 8h"
