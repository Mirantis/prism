@slack
Feature: Slack Heartbeat Trigger
  As a team member I want the agent to react to messages in a Slack
  channel without being @mentioned so it can act on operational alerts

  Scenario: Bot reacts to a non-mention message in a trigger channel
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And the channel is configured as a heartbeat trigger with throttle 0
    When I post "ALERT: production deployment failed at 14:32 UTC, action required" in the channel
    Then the bot should post a reply in the channel within 90 seconds
    And a HEARTBEAT-triggered agent message exists for the agent
