Feature: CLI chat with other clients open
  As a user I want the terminal to show my own conversation once
  while other clients use the same agent

  Scenario: Shows my own message once
    Given a second client is connected
    When I send the prompt "Reply with exactly one word: SHOWNONCE7. No other text."
    Then the agent reply contains "SHOWNONCE7"
    And the second client received my message
    And the screen shows my message once

  Scenario: Ignores a message sent on another thread
    Given a second client is connected
    When the second client sends "Reply with exactly one word: OTHERTHREAD7. No other text." on another thread
    Then the other thread gets a reply containing "OTHERTHREAD7"
    And the screen does not show "OTHERTHREAD7"
