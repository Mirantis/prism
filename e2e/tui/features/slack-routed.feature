@slack
Feature: Slack through a router
  An agent on a shared Slack app receives its Slack events from a router and
  makes every Slack call through the router's Slack API proxy. This spec plays
  the router, the ingress in front of the agent's slack port, and the proxy,
  which forwards each call it allows to the real test workspace.

  Scenario: The agent waits for Slack until the router connects it
    Given an agent in routed mode that is in no Slack workspace
    Then the agent lists no Slack workspace
    When the router reports the agent connected to the test workspace
    Then the agent lists the test workspace

  Scenario: The agent refuses a delivery the ingress did not verify
    When an envelope arrives without the ingress verification
    Then the agent answers 401 and handles nothing

  Scenario: Replying to a direct message
    Given the router links my DM with the bot to the agent
    When the router delivers my direct message "Reply with exactly: ROUTEDDM"
    Then the agent replies "ROUTEDDM" in my DM within 120 seconds

  Scenario: Replying to a mention, a thread reply and a feedback click
    Given the router links a new test channel to the agent
    When the router delivers my mention "reply with exactly: ROUTEDMENTION"
    Then the agent replies "ROUTEDMENTION" in the thread within 120 seconds
    When the router delivers my thread reply "Thanks! Now please reply with exactly: ROUTEDREPLY"
    Then the agent answers the thread reply with "ROUTEDREPLY" within 120 seconds
    When the router delivers a thumbs-up click on the agent's last reply
    Then the agent replaces that reply's feedback buttons within 30 seconds

  Scenario: Stale and repeated deliveries are not handled again
    When the router delivers a mention "reply with exactly: ROUTEDSTALE" sent ten minutes ago
    Then the agent stores no message containing "ROUTEDSTALE"
    When the router delivers a mention "reply with exactly: ROUTEDTWICE" twice
    Then the agent replies "ROUTEDTWICE" in the thread within 120 seconds
    And the agent stores one message containing "ROUTEDTWICE"

  Scenario: Joining a thread that already has messages
    Given a thread in the test channel that the agent is not in
    When the router delivers my mention "Reply with exactly: ROUTEDJOIN" in that thread
    Then the agent replies "ROUTEDJOIN" in that thread within 120 seconds
    And the agent read that thread from Slack once and keeps its first message

  Scenario: Unlinking a channel
    When the router unlinks the test channel
    Then the agent has no link for the test channel

  Scenario: Every Slack call goes through the proxy
    Then the agent called only the proxy's methods, with the parameters each one takes
