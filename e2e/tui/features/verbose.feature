Feature: Concise CLI delivery
  As a CLI user I want concise responses by default
  so that a multi-step, tool-using turn arrives as one coherent final answer
  that still shows what the agent did.

  Scenario: A concise tool-using turn delivers a final answer carrying the tool trail
    When I ask the agent to run a shell command and finish with "DONE-9Z"
    Then the shell_exec tool call is shown
    And the final reply containing "DONE-9Z" is rendered

  # Which text lands in which message (e.g. suppression of a specific
  # intermediate sentinel) is model-controlled, so it isn't asserted here — the
  # concise/verbose branching is covered deterministically by the engine unit
  # tests. This proves the concise default delivers end-to-end in the CLI: the
  # tool activity folds onto the single final message.
