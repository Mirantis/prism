@workspace-ux
Feature: Conversation and schedule shortcuts
  People can resume conversations and set up recurring work from the workspace.

  Scenario: Resume a conversation from the overview
    Given the workspace has a design conversation and a release conversation
    When I resume the design conversation from the overview
    Then the design conversation and its history are visible

  Scenario: Filter recent conversations and recover from an empty result
    Given the workspace has a design conversation and a release conversation
    When I search recent conversations for "DESIGN"
    Then only the design conversation appears in Recents
    When I search recent conversations for "no matching title"
    Then I see an empty conversation search result
    When I clear the conversation search
    Then both workspace conversations appear in Recents

  Scenario: Start a conversation from the phone menu
    Given the workspace has a design conversation and a release conversation
    When I start a new conversation from the phone menu
    Then the phone menu closes and the empty chat composer is visible

  Scenario Outline: Create a task from a schedule preset
    When I create a workspace task with the "<preset>" preset at "<size>" size
    Then the task card shows "<description>" and "<expression>"
    And the workspace content fits without horizontal scrolling
    When I reload the schedule page
    Then the task card shows "<description>" and "<expression>"
    When I delete the workspace task
    Then the workspace task is removed
    Examples:
      | preset   | description              | expression  | size    |
      | Daily    | Every day at 09:00        | 0 9 * * *   | desktop |
      | Weekdays | Monday–Friday at 09:00    | 0 9 * * 1-5 | phone   |
      | Weekly   | Every Monday at 09:00     | 0 9 * * 1   | desktop |

  Scenario: Correct an invalid custom schedule
    When I submit an invalid workspace schedule
    Then the schedule form remains open with an error
    When I correct the workspace schedule to "30 14 * * 2"
    Then the custom workspace schedule is saved
    When I delete the workspace task
    Then the workspace task is removed
