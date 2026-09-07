Feature: Coding sub-agent
  As a user I want the agent to hand a coding task to its coding sub-agent
  so that larger jobs run outside its own turn-by-turn loop

  Background:
    Given I am logged in
    And I have a personal agent
    And the agent is in verbose mode

  # @slow: two model turns plus a real Claude Code run on Bedrock.
  @slow
  Scenario: Delegate a task to the coding sub-agent and read its result
    When I navigate to the agent chat page
    And I type "Use the coding_agent tool exactly once, in plan mode with maxTurns 3, giving it this prompt: Reply with exactly the word PONG and nothing else. Then call coding_agent_status with waitMs 30000 until completed is true. Reply with one line only: RESULT=<the result> STOP=<the stopReason>." in the chat input
    And I send the message
    Then the agent reply contains "STOP=end_turn"
    And no reply is an error
    And the conversation shows a "Coding Agent" tool call
    And the stored tool calls include "coding_agent" and "coding_agent_status"
    When I navigate to the activity page
    Then the activity shows a "Coding Agent" tool call
