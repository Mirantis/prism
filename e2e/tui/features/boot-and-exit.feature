Feature: CLI boot and shutdown
  As a user I want prism-cli to boot against the runtime and shut down cleanly

  Scenario: Boots and renders the header
    Then the chat header and input box are visible

  Scenario: The /exit command shuts down cleanly
    When I submit the /exit command
    Then the CLI shuts down with exit code 0

  Scenario: Ctrl+C shuts down cleanly
    When I press Ctrl+C
    Then the CLI shuts down with exit code 0
