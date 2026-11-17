Feature: Running a shell command from the composer (TUI)
  As a user I want to run a command in my terminal with "!", so the agent
  receives the command and what it printed, and continues its work.

  Scenario: The command runs in the terminal and the agent receives its output
    When I run "! echo PRISMSHELL9K; exit 3" from the composer
    Then the chat shows the command with exit code 3
    And the stored user message records the command, exit code 3 and the output "PRISMSHELL9K"
    And the agent replies
