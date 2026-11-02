Feature: Coding agent sign-in
  As a user I want to sign the agent's coding agent in to my own Claude or
  ChatGPT subscription, so its coding tasks run on that subscription

  Background:
    Given I am logged in
    And I have a personal agent

  # A real sign-in needs a subscription, so these scenarios stop at the step
  # where the person signs in on the provider's page.
  @claude-subscription
  Scenario: Start a Claude sign-in from the Profile page, and open it again from its link
    Given "Claude Code" is not signed in to a subscription
    When I navigate to the profile page
    And I start signing "Claude Code" in
    Then the Claude sign-in asks for the code from its sign-in page
    When I close the sign-in
    And I open the link the agent sends for the "Claude Code" sign-in
    Then the Claude sign-in asks for the code from the same sign-in page

  @codex-subscription
  Scenario: Start a ChatGPT sign-in from the Profile page
    Given "Codex" is not signed in to a subscription
    When I navigate to the profile page
    And I start signing "Codex" in
    Then the ChatGPT sign-in shows a code to enter on its sign-in page
