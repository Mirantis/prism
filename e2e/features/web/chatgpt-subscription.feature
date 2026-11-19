Feature: ChatGPT subscription provider
  As a user running Prism with LLM_PROVIDER=chatgpt I want to sign in with my
  ChatGPT account from the Profile page so Prism runs on my ChatGPT plan

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: ChatGPT subscription card is hidden on other LLM providers
    Given the runtime is not configured for the ChatGPT subscription provider
    When I navigate to the profile page
    Then the ChatGPT subscription card is not shown

  # A completed sign-in needs an interactive ChatGPT account login, so this
  # scenario stops after verifying the real authorization URL from the runtime.
  @chatgpt-subscription
  Scenario: Start Sign in with ChatGPT from the Profile page
    Given the runtime is configured for the ChatGPT subscription provider and not signed in
    When I navigate to the profile page
    And I click Sign in with ChatGPT
    Then the ChatGPT subscription card waits for browser sign-in with an OpenAI authorization link
