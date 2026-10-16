Feature: Remote computers
  As a user I want Prism to use a computer of mine, and to see on the Computer page
  whether it is connected

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A computer of mine is listed, used by Prism, and removed
    Given my computer "E2E laptop" shows the secret word "PINEAPPLE" and connects to Prism
    When I open the Computer page
    Then "E2E laptop" is listed as connected
    When I navigate to the agent chat page
    And I type "Look at the screen of E2E laptop and tell me the secret word written on it." in the chat input
    And I send the message
    Then the agent reply contains "PINEAPPLE"
    And "E2E laptop" was asked for a picture of its screen
    When I remove "E2E laptop" on the Computer page
    Then "E2E laptop" is no longer listed
    And the computer client of "E2E laptop" is told its computer was removed
