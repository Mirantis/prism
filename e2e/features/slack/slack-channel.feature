@slack
Feature: Slack Channel Integration
  As a team member I want to interact with the agent in a Slack channel
  so that I can get help without leaving Slack

  Scenario: Bot responds when mentioned in a channel
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    When I send a message mentioning the bot "What is your name?"
    Then the bot should reply in the thread within 60 seconds
    And the bot's reply should not be empty
