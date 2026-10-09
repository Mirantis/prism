Feature: Memory search
  As a user I want the agent to look up what it recorded on a given day
  so that a question about a date gets the entries from that date

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The agent searches its memory by date
    Given the agent recorded "The incident review owner is TEALMARMOT3" 3 days ago
    And the agent recorded "The incident review owner was COPPERWREN8" 10 days ago
    When I navigate to the agent chat page
    And I ask the agent what it recorded 3 days ago
    Then the agent reply contains "TEALMARMOT3"
    And no reply is an error
    And no reply mentions "COPPERWREN8"
    And the agent searched its memory from a start time
