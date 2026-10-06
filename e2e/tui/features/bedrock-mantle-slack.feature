@slack
Feature: Slack thread classification on Bedrock Mantle
  As an operator running LLM_PROVIDER=bedrock-mantle I want the thread
  classifier to keep working, so the agent stays quiet on chatter between
  humans instead of replying to every message in a thread it is part of

  # The status-line step rides along in this scenario rather than living in a
  # suite of its own: the working cue is write-only on the Slack API (nothing
  # reads it back), so the runtime log is the only end-to-end evidence that it
  # rendered — and this is the one spec that drives a real channel thread and
  # can read that log. A second @slack spec would also fight this one for the
  # workspace's single Socket Mode connection.
  Scenario: Stays quiet on human-to-human chatter
    Given a Slack channel linked to the mantle agent
    And the bot has replied in a thread
    And Slack accepted the working status line on that thread
    When a human posts a follow-up aimed at another person
    Then the classifier decides to ignore the follow-up
    And the bot adds no reaction to the follow-up
    And the bot posts no reply to the follow-up
    And the classifier did not fall back
