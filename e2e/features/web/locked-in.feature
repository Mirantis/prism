Feature: Locked-in mode
  As a user I want to freeze my agent's identity documents against its own edits

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Profile toggle persists locked-in mode
    When I navigate to the profile page
    And I toggle locked-in to true
    Then the agent details show locked-in is true
    When I toggle locked-in to false
    Then the agent details show locked-in is false

  Scenario: The profile toggle says the lock is not a security boundary
    When I navigate to the profile page
    Then the locked-in toggle is described as a drift guardrail

  Scenario: A locked agent refuses to rewrite its soul and leaves it unchanged
    Given the agent is locked in
    When I navigate to the agent chat page
    And I type "Use your update_soul tool to append the line PIRATEMODE7K to your soul document. Then tell me whether it worked." in the chat input
    And I send the message
    Then the stored soul document is unchanged

  Scenario: An unlocked agent still rewrites its soul
    Given the agent is not locked in
    When I navigate to the agent chat page
    And I type "Use your update_soul tool to append the line PIRATEMODE7K to your soul document. Then tell me whether it worked." in the chat input
    And I send the message
    Then the stored soul document changes
