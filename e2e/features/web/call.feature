Feature: A voice call on the agent's computer
  As a user I want my agent to join a call in its own browser and take part by voice, so
  it works with whatever call app my team uses

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Prism joins a web call with its computer, speaks in it, and leaves
    Given the runtime can give the agent a computer
    And a call page on the web
    And the voice model has heard nothing yet
    When I ask Prism to join the call using its computer
    Then Prism's browser joined the call
    And the voice model hears the call
    And the call hears Prism's voice
    When I ask Prism to leave the call
    Then the call page shows Prism left
    And the voice model has no session open
