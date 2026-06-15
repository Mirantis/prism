@slack
Feature: Slack file sharing
  As a team member I want to share files with the agent in Slack
  and receive files it creates, without leaving Slack

  Background:
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI

  Scenario: The agent reads a file uploaded in a channel
    When I upload a file named "brief.txt" containing "The Slack code is SLACKIN42." mentioning the bot "read the attached file and reply with only the code in it"
    Then the bot should reply about the file within 90 seconds
    And the file reply should contain "SLACKIN42"

  Scenario: The agent creates a file and shares it back to the channel
    When I send a message mentioning the bot "Create a file named result.txt whose exact contents are SLACKOUT7, then share that file with me."
    Then the bot should share a file named "result.txt" in the thread within 120 seconds
    And the shared file should contain "SLACKOUT7"
