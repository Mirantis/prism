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

  # Regression for AGENT-74: a channel linked under a legacy (multi-tenant)
  # connectionId — one that no longer matches the env connection's teamId —
  # must still appear on /channels and be unlinkable.
  Scenario: A channel linked under a legacy connectionId stays manageable
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And the channel mapping has a legacy connectionId
    When I reload the Channels page
    Then the linked channel is still listed
    And I can unlink the channel from the UI
