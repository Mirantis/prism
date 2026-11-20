@no-llm-provider
Feature: No LLM provider
  As someone who starts Prism without an LLM credential I want to be told what is missing
  so that I know why the agent does not answer and what to set

  Background:
    Given I am logged in
    And I have a personal agent
    And the runtime was started with no LLM credential

  Scenario: The Overview warns that no LLM provider is configured
    When I navigate to the overview page
    Then the overview warns that no LLM provider is configured, naming "AWS_BEARER_TOKEN_BEDROCK"
    When I copy the provider setting "AWS_BEARER_TOKEN_BEDROCK"
    Then the clipboard holds "AWS_BEARER_TOKEN_BEDROCK"

  Scenario: A message is answered with the setting the provider needs
    When I navigate to the agent chat page
    And I type "Hello" in the chat input
    And I send the message
    Then I should see the message "I am not fully configured yet: the bedrock LLM provider needs AWS_BEARER_TOKEN_BEDROCK." in the conversation
