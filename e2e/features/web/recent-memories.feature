Feature: Recent memories
  As a user I want a new conversation to start from what the agent recorded shortly before
  so that I do not have to explain again what we were working on

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A new conversation opens with what the agent recorded in the last hours
    Given the agent recorded "The release codename is ORCHIDFALCON9" 1 hour ago
    And the agent recorded "The release codename was GRANITEHERON2" 30 hours ago
    When I navigate to the agent chat page
    And I type "Without using any tools: which release codename did you note most recently? Reply with the codename alone." in the chat input
    And I send the message
    Then the agent reply contains "ORCHIDFALCON9"
    And no reply is an error
    And the conversation opened with one recent-memory block holding "ORCHIDFALCON9" and not "GRANITEHERON2"
    And the conversation history shows me no recent-memory block

  Scenario: A voice chat opens with what the agent recorded in the last hours
    Given the agent recorded "The release codename is ORCHIDFALCON9" 1 hour ago
    And I open a fresh chat
    And the voice model has heard nothing yet
    When I start a voice chat from the chat header
    Then the chat shows the call is live
    And the voice session opened holding "The release codename is ORCHIDFALCON9"
    When I end the voice chat
    Then the voice model has no session open
