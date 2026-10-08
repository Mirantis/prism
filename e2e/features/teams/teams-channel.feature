@teams
Feature: Microsoft Teams integration
  As a user I want to link the agent to Microsoft Teams
  so that I can chat with it in personal chats and channels

  # The @teams suite needs a pre-provisioned Microsoft 365 test tenant:
  # a team + channel with the bot app added, a personal chat between the
  # human test user and the bot, a delegated Graph user token to post as
  # the human, and the Azure Bot's messaging endpoint pointing at this
  # runtime via a path-restricted proxy + tunnel that exposes only
  # POST /agents/teams/messages (see e2e/README.md). It skips itself when
  # the TEAMS_E2E_* env vars are missing — exactly like the @slack suite.

  Scenario: Linking a personal chat and getting a reply
    Given I generate a Teams personal link code via the UI
    When I send the link code in the Teams personal chat
    Then the Teams DM mapping exists in the database
    When I send "What is your name?" in the Teams personal chat
    Then the bot should reply in the personal chat within 90 seconds

  Scenario: Linking a personal chat with a link code pasted as rich text
    Given I generate a Teams personal link code via the UI
    When I paste the link code as rich text in the Teams personal chat
    Then the Teams DM mapping exists in the database

  Scenario: Linking a channel and getting a threaded reply
    Given I generate a Teams channel link code via the UI
    When I mention the bot in the Teams channel with the link code
    Then the Teams channel mapping exists in the database and is the main channel
    When I mention the bot in the Teams channel with "What is your name?"
    Then the bot should reply in that thread within 90 seconds

  Scenario: Following up in a thread without a mention
    Given I generate a Teams channel link code via the UI
    When I mention the bot in the Teams channel with the link code
    And I mention the bot in the Teams channel with "What is your name?"
    Then the bot should reply in that thread within 90 seconds
    When I reply in that thread without a mention with "And what is two plus two?"
    Then the bot should answer that reply within 90 seconds

  Scenario: Reading an image pasted in the personal chat
    Given I generate a Teams personal link code via the UI
    When I send the link code in the Teams personal chat
    And I paste an image of a red square in the Teams personal chat asking "What color is this image? Answer with one word."
    Then the bot should reply in the personal chat with "red" within 90 seconds

  # The send_message tool: the agent posts a new top-level message in the
  # linked channel and mentions the person who asked. Graph reports the
  # mention only when the message has a mention entity Teams accepted.
  Scenario: The agent posts a new channel message that mentions a person
    Given I generate a Teams channel link code via the UI
    When I mention the bot in the Teams channel with the link code
    And I ask the bot in the Teams channel to post a new message that mentions me
    Then the bot should reply in that thread within 90 seconds
    And the channel has the bot's new message mentioning me within 90 seconds
