Feature: Webhook subscriptions panel (TUI)
  As a user I want to pause and edit my webhook subscriptions from the
  terminal. Subscriptions are seeded and verified through the runtime's REST API.

  Scenario: Pause a subscription from the list
    Given a webhook subscription "tui-alerts" exists
    When I open the webhooks panel
    Then I see "tui-alerts"
    When I press space on the selected subscription
    Then the stored subscription "tui-alerts" is paused

  # The channels are linked rows in the agent's database: this suite runs with
  # no Slack connection.
  Scenario: Choose the Slack channel a Slack subscription posts to
    Given a Slack webhook subscription "tui-release" exists
    And the agent has the linked Slack channels "release-notes" and "ios-testflight"
    When I open the webhooks panel
    And I check the Slack channel "ios-testflight" of "tui-release" and save
    Then the stored subscription "tui-release" posts to the Slack channel "ios-testflight"

  # The prompt is written in $EDITOR. The description is typed before the
  # editor opens, so it is saved only if the form survives the hand-off.
  Scenario: Edit a subscription, with the prompt written in the editor
    Given a webhook subscription "tui-alerts" exists
    When I open the webhooks panel with an editor that writes "Edited prompt WEBHOOKTUI7Q"
    And I edit "tui-alerts" with the description "Paged alerts" and a prompt from the editor
    Then the stored subscription "tui-alerts" has the description "Paged alerts" and the prompt "Edited prompt WEBHOOKTUI7Q"
