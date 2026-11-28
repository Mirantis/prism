Feature: Prism as an Agent Client Protocol agent
  As a developer I want to use my Prism agent from an editor that speaks the
  Agent Client Protocol, so the agent works on the project I have open there.

  Scenario: An ACP client prompts the agent in a project folder, and a later client loads the session
    Given an ACP client that started "prism acp"
    When the client starts a session in a project folder
    And the client prompts the agent to run "pwd" in its shell
    Then the prompt ends with the stop reason "end_turn"
    And the client was shown the shell_exec tool call and a reply that names the project folder
    When a second ACP client starts "prism acp"
    Then it lists the session under the project folder
    And loading the session replays the prompt and the reply

  Scenario: The ACP client quits while a prompt is still running
    Given an ACP client that started "prism acp"
    When the client starts a session in a project folder
    And the client prompts the agent to run "sleep 30" in its shell
    And the agent is working on the prompt
    When the client closes its end of the connection
    Then "prism acp" exits within 5 seconds
