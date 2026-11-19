Feature: No LLM provider
  As someone who starts Prism without an LLM credential I want prism to say so when it starts
  so that I know why the agent does not answer and what to set (no LLM call)

  Scenario: prism warns at startup that no LLM provider is configured
    Then the screen warns that no LLM provider is configured, naming "AWS_BEARER_TOKEN_BEDROCK"
