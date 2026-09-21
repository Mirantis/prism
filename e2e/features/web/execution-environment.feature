Feature: Execution environment
  As an operator I want the agent's commands to run in a container while the
  files they work on stay on my machine, so the shell has a boundary without
  taking my work behind one

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A command runs in the container and its file lands on the host
    Given the agent's commands run in a container
    When I navigate to the agent chat page
    # One command does all of it. The write has to be part of the command:
    # shell_write_file is served by the runtime's own filesystem, so it would
    # produce the same file whichever environment is in force and prove nothing.
    And I type "Use shell_exec once with this exact command: cat /etc/os-release | head -1 && uname -s && echo from-the-container > host-proof.txt. Reply with one line only: OS=<the first line of stdout> KERNEL=<the uname output>" in the chat input
    And I send the message
    # Debian is the exec image; the host running this suite is not.
    Then the agent reply contains "Debian"
    And the agent reply contains "KERNEL=Linux"
    And no reply is an error
    # The point of the mount: the command ran in a container, and the file it
    # wrote is readable on this machine at the same path.
    And the workspace file "host-proof.txt" contains "from-the-container"
