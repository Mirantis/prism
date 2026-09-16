@slack
Feature: Computer help from Slack
  Scenario: Sign-in help links to the configured public Computer page
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    When I ask for computer sign-in help from Slack
    Then the Slack help message links to the configured public Computer page
