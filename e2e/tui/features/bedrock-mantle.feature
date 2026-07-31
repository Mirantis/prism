Feature: Bedrock Mantle provider
  As an operator I want to run the container with LLM_PROVIDER=bedrock-mantle
  and have the agent answer over the mantle Anthropic endpoint

  Scenario: Boots with the mantle provider selected
    Then the startup log reports provider "bedrock-mantle" routing "direct"
    And the resolved chat model is a bare Bedrock ID

  Scenario: Answers a chat turn over the mantle endpoint
    When I send the prompt "Reply with exactly one word: MANTLEACK7. No other text."
    Then the agent reply contains "MANTLEACK7"
    And no model was rejected by the endpoint

  Scenario: Strips a cross-region prefix from a stored model override
    Given the agent's model override is "us.anthropic.claude-opus-5"
    When I send the prompt "Reply with exactly one word: STRIPPED9. No other text."
    Then the agent reply contains "STRIPPED9"
    And the runtime logged that it stripped the inference-profile prefix
