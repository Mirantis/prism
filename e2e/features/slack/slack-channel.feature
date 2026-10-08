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

  # The working cue in a channel is the assistant-thread status line, which
  # Slack accepts on regular channel threads (verified by direct probe) but
  # keeps write-only on the API — so it is covered by unit tests instead. The
  # eyes reaction is only a fallback for when setStatus fails, so no reaction
  # is expected (or asserted) here.

  # Multiple channels can be linked to one agent, and one is the "main"
  # channel (where heartbeat alerts post). The first-linked channel is main by
  # default; the user can move it.
  Scenario: Linking multiple channels and choosing the main channel
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And a second test Slack channel exists
    And the bot is invited to the second channel
    And I link the second channel to the agent via the UI
    Then both channels are listed on the Channels page
    And the first channel is the main channel
    When I set the second channel as the main channel
    Then the second channel is the main channel
    And only the second channel is flagged main in the database

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

  # The send_message tool: from a turn in one linked channel, the agent posts a
  # new message in another linked channel and mentions the person who asked.
  # The mention is asserted on the message Slack stored, after it translated
  # the markdown block, so the assertion holds only for a mention Slack parsed.
  Scenario: The agent posts to another linked channel and mentions a person
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And a second test Slack channel exists
    And the bot is invited to the second channel
    And I link the second channel to the agent via the UI
    When I ask the bot to post a message that mentions me in the second channel
    Then the bot should reply in the thread within 120 seconds
    And the second channel has the bot's message mentioning me within 60 seconds
    And the run's stored reply records the sent message
