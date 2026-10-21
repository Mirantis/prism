Feature: Auto model selection
  As a user I want the agent to answer simple requests on a cheaper model and
  demanding ones on a capable model, so I do not pay the capable model's price
  for every turn

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Choosing Auto asks for the models and Save turns it on
    When I navigate to the profile page
    And I turn on Auto model selection
    Then the profile asks for a small and a large model
    And the stored model mode is still Fixed
    When I enter the small and the large test models
    And I save the Auto models
    Then the profile shows Auto model selection
    And the stored model mode is Auto

  # @slow: the large-tier request writes code with tests, a turn that can take a few minutes.
  @slow
  Scenario: Each turn runs on the model its request needs
    Given the agent chooses between the small and the large test models
    When I ask "What is 2 + 2? Reply with the number only."
    Then the turn ran on the small test model
    When I ask "Write a TypeScript function that parses ISO 8601 durations, with unit tests, and explain each edge case."
    Then the turn ran on the large test model
    And each turn's routing call is recorded
