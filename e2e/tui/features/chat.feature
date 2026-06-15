Feature: CLI chat round-trip
  As a user I want to chat with the agent through prism-cli over WebSocket
  and see its reply rendered in the terminal

  Scenario: Sends a prompt and renders the agent reply
    When I send the prompt "Reply with exactly one word: PRISMACK7. No other text."
    Then my message appears in the chat
    And the agent reply contains "PRISMACK7"
