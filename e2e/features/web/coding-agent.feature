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

  # @slow: two model turns plus a real Claude Code run on Bedrock.
  @slow
  Scenario: A delegated task reports the action its permission checks refused
    Given the coding agent's settings deny writing "refused-by-policy.txt"
    When I navigate to the agent chat page
    And I type "Use the coding_agent tool exactly once, with agent claude-code in edit mode, giving it this prompt: Create the file refused-by-policy.txt in the current directory containing the word nope. Use only the Write tool. If the write is refused, stop and report it. Then call coding_agent_status with waitMs 30000 until completed is true. Reply with one line only: STOP=<the stopReason>" in the chat input
    And I send the message
    Then the agent reply contains "STOP=refused"
    And the coding task reports a refused "Write" of "refused-by-policy.txt"
    And the workspace has no file "refused-by-policy.txt"

  # @slow: two model turns plus a real Claude Code run on Bedrock. The demo
  # plugin's MCP tool answers a marker the agent can only learn by calling it,
  # and the agent never calls it itself, so the marker came from the sub-agent.
  @slow
  Scenario: The coding sub-agent calls an MCP tool the agent has
    When I navigate to the agent chat page
    And I type "Use the coding_agent tool exactly once, with maxTurns 5, giving it this prompt: Call the MCP tool mcp__demo__probe__plugin_mcp_probe and reply with exactly what it returns and nothing else. Then call coding_agent_status with waitMs 30000 until completed is true. Call no other tool. Reply with one line only: RESULT=<the result>." in the chat input
    And I send the message
    Then the agent reply contains "PLUGIN_MCP_TOOL_OK"
    And no reply is an error
    And the stored tool calls include "coding_agent" and "coding_agent_status"
    And the stored tool calls do not include "demo__probe__plugin_mcp_probe"

  # @slow: two model turns plus a real Claude Code run on Bedrock. The server is
  # in the workspace's .mcp.json, which only Claude Code loads.
  @slow
  Scenario: The coding sub-agent calls an MCP tool from the workspace's .mcp.json
    Given the workspace's .mcp.json has a server "workspace-probe" that answers "WORKSPACE_MCP_TOOL_OK"
    When I navigate to the agent chat page
    And I type "Use the coding_agent tool exactly once, with agent claude-code and maxTurns 5, giving it this prompt: Call the MCP tool mcp__workspace-probe__plugin_mcp_probe and reply with exactly what it returns and nothing else. Then call coding_agent_status with waitMs 30000 until completed is true. Call no other tool. Reply with one line only: RESULT=<the result>." in the chat input
    And I send the message
    Then the agent reply contains "WORKSPACE_MCP_TOOL_OK"
    And no reply is an error
    And the stored tool calls include "coding_agent" and "coding_agent_status"

  # @slow: a real Claude Code run on Bedrock that takes at least 30 seconds, and
  # the two model turns around it. The task's end, not a timer, starts the second.
  # The shell computes the marker's number, so only the task's output holds it.
  @slow
  Scenario: A finished coding task reports back without a wait
    When I navigate to the agent chat page
    And I type "Ask the coding agent, in edit mode with maxTurns 5, to run the shell command `sleep 30 && echo NOTIFY-RESULT-$((4100+82))` and to reply with exactly what it printed. Then tell me what it printed." in the chat input
    And I send the message
    Then the chat composer should be ready for input again
    And the coding task's result reaches the conversation as a task notification
    And an agent reply after the task notification contains "NOTIFY-RESULT-4182" within 60 seconds
    And the agent set no timer for the coding task
    And no reply is an error

  # @slow: a real Claude Code run on Bedrock that takes at least 90 seconds, and
  # three model turns. Waiting inside a turn would hold the question until then.
  @slow
  Scenario: The agent answers a question while a coding task runs
    When I navigate to the agent chat page
    And I type "Ask the coding agent, in edit mode with maxTurns 5, to run the shell command `sleep 90 && echo NOTIFY-LATE-$((5500+21))` and to reply with exactly what it printed. Then tell me what it printed." in the chat input
    And I send the message
    Then the chat composer should be ready for input again
    When I type "While that runs: what is 17 times 3? Reply with the number only." in the chat input
    And I send the message
    Then the agent reply contains "51"
    And the reply with "51" came before the task notification
    And the coding task's result reaches the conversation as a task notification
    And an agent reply after the task notification contains "NOTIFY-LATE-5521" within 60 seconds
    And no reply is an error
