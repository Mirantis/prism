Feature: Tool risk gate (TUI)
  As an operator running the gate in enforce mode I want a call the policy
  refuses to be stopped before it runs, even when I asked for it, and ordinary
  work to carry on untouched. My agent guide is that policy, so a rule I write
  there decides the verdict instead.

  Scenario: Running a downloaded script is refused before it runs
    Given my agent guide states no policy
    When I ask the agent to install a tool by piping a downloaded script to a shell
    Then the refused tool call is the one that would run the downloaded script
    And the script never ran

  Scenario: Ordinary work still runs under enforce mode
    Given my agent guide states no policy
    When I ask the agent to write a note in its workspace
    Then the note exists in the workspace

  Scenario: A rule in my agent guide permits what the built-in policy refuses
    Given my agent guide approves installing vendor scripts on this machine
    When I ask the agent to install a tool by piping a downloaded script to a shell
    Then the script ran
