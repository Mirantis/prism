Feature: Execution environment
  As an operator I want the agent's commands and its storage to live in a
  container, so the shell has a boundary and the work it keeps survives a
  restart

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A command runs in the container and what it writes is kept
    Given the agent's commands run in a container
    When I navigate to the agent chat page
    # One command does all of it. The write has to be part of the command:
    # shell_write_file goes through the same seam either way, so on its own it
    # would not say which side the bytes landed on.
    And I type "Use shell_exec once with this exact command: cat /etc/os-release | head -1 && pwd && echo from-the-container > kept.txt. Reply with one line only: OS=<the first line of stdout> CWD=<the pwd output>" in the chat input
    And I send the message
    # Debian is the exec image; the host running this suite is not.
    Then the agent reply contains "Debian"
    And the agent reply contains "CWD=/prism/workspace"
    And no reply is an error
    # The file is in a volume, so the engine is what can be asked about it —
    # and it is still there after the container is replaced, which is the
    # persistence the agent's work depends on.
    And the agent's workspace file "kept.txt" contains "from-the-container"
    And the file is still there after the container is replaced
