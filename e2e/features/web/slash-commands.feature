Feature: Slash-command popup
  As a user I want the chat composer to list the slash commands it accepts and
  to complete the one I have started typing. The popup is one widget over one
  registry, so it is asserted once here rather than per command.

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Typing "/" lists the available commands
    When I navigate to the agent chat page
    And I type "/" in the chat input
    Then I should see the command popup
    And the command popup should list "/help"
    And the command popup should list "/skills"
    And the command popup should list "/goal"
    And the command popup should list "/plugins"

  # One prefix is enough: filtering and completion run through one code path, so
  # `/go` would exercise what `/sk` already does.
  Scenario: Tab autocompletes the highlighted command
    When I navigate to the agent chat page
    And I type "/sk" in the chat input
    And I press Tab in the chat input
    Then the chat input should contain "/skills"
