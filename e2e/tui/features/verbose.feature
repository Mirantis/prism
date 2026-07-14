Feature: Concise CLI delivery
  As a CLI user I want concise responses by default
  so that a multi-step, tool-using turn arrives as one coherent final answer
  that still shows what the agent did.

  Scenario: A concise tool-using turn delivers a final answer carrying the tool trail
    When I ask the agent to run a shell command and finish with "DONE-9Z"
    Then the shell_exec tool call is shown
    And the final reply containing "DONE-9Z" is rendered
    And the turn stored exactly 1 agent message

  # Which text lands in which message (e.g. suppression of a specific
  # intermediate sentinel) is model-controlled, so it isn't asserted on screen —
  # instead the stored AGENT-message count is the authoritative discriminator:
  # verbose delivery stores one row per text-bearing step, concise exactly one
  # for the whole turn. This proves the concise default delivers end-to-end in
  # the CLI: one final message carrying the tool trail.
