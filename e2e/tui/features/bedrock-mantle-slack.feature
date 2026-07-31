@slack
Feature: Slack thread classification on Bedrock Mantle
  As an operator running LLM_PROVIDER=bedrock-mantle I want the thread
  classifier to keep working, so the agent reacts to chatter between humans
  instead of replying to every message in a thread it is part of

  Scenario: Reacts with an emoji instead of replying to human-to-human chatter
    Given a Slack channel linked to the mantle agent
    And the bot has replied in a thread
    When a human posts a follow-up aimed at another person
    Then the classifier decides on a reaction rather than a reply
    And the bot adds an emoji reaction to that message
    And the bot posts no reply to the follow-up
    And the classifier did not fall back
