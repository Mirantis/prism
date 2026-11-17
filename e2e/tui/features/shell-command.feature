Feature: Running a shell command from the composer (TUI)
  As a user I want to run a command in my terminal with "!", so the agent
  receives the command and what it printed, and continues its work.

  Scenario: The command runs in the terminal and the agent receives its output
    When I run "! echo PRISMSHELL9K; exit 3" from the composer
    Then the chat shows the command with exit code 3
    And the stored user message records the command, exit code 3 and the output "PRISMSHELL9K"
    And the agent replies

  Scenario: A command that asks a question reads the answer typed in the terminal
    When I run "! printf '%s? ' ASK$((40+2)); read answer; echo GOT-$answer" from the composer
    And the command asks "ASK42?" and I answer "PRISMANSWER7Q"
    Then the stored user message records the output "GOT-PRISMANSWER7Q"
    And the composer sends "PRISMAFTERANSWER" as the next message

  Scenario: Ctrl+C stops a waiting command and Prism keeps running
    When I run "! echo WAIT$((40+2)); sleep 600" from the composer
    And the command prints "WAIT42" and I interrupt it
    Then the stored user message records a non-zero exit code
    And the composer sends "PRISMAFTERSTOP" as the next message
