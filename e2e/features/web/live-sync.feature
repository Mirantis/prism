Feature: One conversation on every open client
  As a user with the chat open in two browsers, or sharing an agent with someone
  I want every browser to show the conversation as it happens
  so that I can follow and steer a turn from either one

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A second browser shows the message, who wrote it, and the working agent
    Given a web conversation titled "Live sync"
    And I am signed in as "Ada Example"
    And a second browser, signed in as "Grace Example", has the "Live sync" conversation open
    When I open the "Live sync" conversation
    And I type "Use your shell to run `sleep 8`, then reply with exactly LIVE_SYNC_OK." in the chat input
    And I send the message
    Then the second browser shows the message "Use your shell to run" from "Ada Example" while the agent works
    And the second browser shows a reply containing "LIVE_SYNC_OK"
    And the second browser shows no working indicator
    And the second browser shows the message "Use your shell to run" once
    And I see my message "Use your shell to run" once

  Scenario: The second browser stops a turn the first one started
    Given a web conversation titled "Live sync"
    And a second browser has the "Live sync" conversation open
    When I open the "Live sync" conversation
    And I type "Write a long, detailed essay about the full history of computing." in the chat input
    And I send the message
    Then the second browser shows the working indicator
    When the second browser stops the response
    Then the second browser shows no working indicator
    And the chat composer should be ready for input again

  Scenario: The working indicator clears on the second browser when the turn fails
    Given a web conversation titled "Live sync"
    And the chat model is "global.anthropic.claude-e2e-no-such-model"
    And a second browser has the "Live sync" conversation open
    When I open the "Live sync" conversation
    And I type "hello" in the chat input
    And I send the message
    Then the second browser shows a reply containing "I encountered an error"
    And the second browser showed the working indicator
    And the second browser shows no working indicator

  Scenario: A turn on another thread shows nothing on the second browser
    Given an older web conversation titled "Older talk"
    And a web conversation titled "Current talk"
    And a second browser has the "Older talk" conversation open
    When I open the "Current talk" conversation
    And I type "Use your shell to run `sleep 5`, then reply with exactly OTHER_THREAD_OK." in the chat input
    And I send the message
    Then the agent reply contains "OTHER_THREAD_OK"
    And the second browser never showed the working indicator
    And the second browser does not show the message "Use your shell to run"

  Scenario: A reply that lands while a browser is offline appears when it reconnects
    Given a web conversation titled "Live sync"
    And a second browser has the "Live sync" conversation open
    When I open the "Live sync" conversation
    And I type "Use your shell to run `sleep 8`, then reply with exactly OFFLINE_OK." in the chat input
    And I send the message
    And the second browser goes offline until the agent has replied
    Then the second browser shows a reply containing "OFFLINE_OK"
    And the second browser shows no working indicator

  Scenario: A message for another conversation waits for the running turn
    Given an older web conversation titled "First talk"
    And a web conversation titled "Second talk"
    And a second browser has the "Second talk" conversation open
    When I open the "First talk" conversation
    And I type "Use your shell to run `sleep 10`, then reply with exactly FIRST_OK." in the chat input
    And I send the message
    And the second browser sends "Reply with exactly SECOND_OK."
    Then the second browser shows the message waiting for another conversation
    And the second browser shows a reply containing "SECOND_OK"
    And the agent reply contains "FIRST_OK"
