Feature: Background goals
  As a user I want to set a goal in natural language
  so that the agent keeps working toward it autonomously across turns

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Natural language sets a background goal that runs autonomously
    When I navigate to the agent chat page
    And I type "Please set yourself a goal and pursue it autonomously across multiple turns until it is done: write a short haiku about Kubernetes, then refine it once, then the goal is complete." in the chat input
    And I send the message
    Then a goal is created for the agent
    And the agent runs at least one autonomous goal turn
    And the goal reaches a terminal status
