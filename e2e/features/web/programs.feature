Feature: Programs that call tools
  As a user I want the agent to do many tool calls in one program
  so that a repetitive task takes one step and a short answer

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The agent runs shell commands in a loop inside one program
    When I navigate to the agent chat page
    And I ask the agent to square the numbers 1 to 6 with the shell in one program
    Then the agent reply contains "91"
    And no reply is an error
    And one run_program call made 6 shell calls
