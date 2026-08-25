Feature: Self-update surfaces
  The e2e runtime runs from source, not a packaged binary, so the updater is
  off — these scenarios pin the disabled-state surfaces in the web UI.

  Background:
    Given I have a personal agent

  Scenario: No update banner when the install cannot self-update
    Given I open a fresh chat
    Then the update banner is not shown
    And the update status reports the updater is off

  Scenario: /update reports why updates are off in this install
    Given I open a fresh chat
    When I type "/update" in the chat input
    And I send the message
    Then I should see the message "This install updates by other means (pull a new image, or restart the dev server)." in the conversation
