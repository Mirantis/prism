Feature: CLI workspace root
  As a user I want the agent's shell tools to operate from the directory I
  launched the CLI in, so a conversation is rooted in my current project.

  Scenario: The new thread's workspace root is the CLI's working directory
    Then the latest thread's workspace root equals the CLI working directory
