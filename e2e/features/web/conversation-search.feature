Feature: Conversation search
  As a user I want the agent to find what I said in another conversation, so I
  do not have to repeat it or ask the agent to remember it first

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The agent quotes a fact from another conversation
    Given an earlier conversation where I said "The staging cluster codename is TANGERINE-42."
    And I open a fresh chat
    And I start a new conversation from the sidebar
    When I type "What staging cluster codename did I give you in another conversation?" in the chat input
    And I send the message
    Then the agent reply contains "TANGERINE-42"
    And the agent searched its conversations
