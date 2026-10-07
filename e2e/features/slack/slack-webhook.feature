@slack
Feature: Slack webhook delivery channels
  As a user I want a webhook that delivers to Slack to post into the linked
  channels I choose, so a release workflow can post its notes straight into a
  release channel. Choosing the channels on the Webhooks page is covered in the
  web suite; this feature checks where the message lands in Slack.

  # The first-linked channel is the main channel, where a Slack delivery goes
  # when no channel is chosen.
  Scenario: A Slack webhook posts to its chosen channel and not to the main channel
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And a second test Slack channel exists
    And the bot is invited to the second channel
    And I link the second channel to the agent via the UI
    And a deliver-only Slack webhook "release-notes" with template "Release {version} is out" posts to the second channel
    When I POST the payload '{"version":"2026.10.7"}' to webhook "release-notes"
    Then the webhook response status is 200
    And the bot posts "Release 2026.10.7 is out" in the second channel
    And the bot posts nothing in the first channel
