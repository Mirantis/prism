Feature: Verbose / concise delivery mode
  As a user I want to control whether intermediate agent steps are delivered

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Concise mode delivers only the final agent message, even after reload
    Given the agent is in concise mode
    When a multi-step chat turn completes
    Then only one agent message is delivered via the channel
    And the database contains multiple AGENT rows for the thread
    And the intermediate steps are flagged internal in the database
    And the agent message shows the tool calls of the hidden steps
    And the delivered agent message arrives unmarked
    When I reload the chat page
    Then only one agent message is shown
    And the agent message shows the tool calls of the hidden steps
    And the history marks no agent message as a step

  Scenario: Verbose mode streams every intermediate step
    Given the agent is in verbose mode
    When a multi-step chat turn completes
    Then multiple agent messages are delivered via the channel
    And every delivered agent message but the reply arrives marked as a step
    And the history marks every agent message but the reply as a step

  Scenario: Profile toggle persists verbose setting
    When I navigate to the profile page
    And I toggle verbose to true
    Then the agent details show verbose is true
    When I toggle verbose to false
    Then the agent details show verbose is false
