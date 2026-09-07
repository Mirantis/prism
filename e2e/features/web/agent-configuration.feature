Feature: Agent Configuration
  As a user I want to view and edit my agent's configuration

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: View agent properties
    When I navigate to the agent detail page
    Then I should see the agent stat cards
    And I should see the agent type badge
    And I should see the heartbeat status

  Scenario: View profile tabs
    When I navigate to the agent detail page
    Then I should see profile tabs for "Agent", "Soul", "User", "Heartbeat", "Memory"

  Scenario: Default heartbeat interval is 8 hours
    When I navigate to the agent detail page
    Then I should see the heartbeat interval "Every 8h"

  Scenario: Edit the agent guide and save it
    When I navigate to the profile page
    Then the agent guide editor shows the stored guide
    When I set the agent guide to "Answer with GUIDEEDIT7K."
    And I save the agent guide
    Then the stored agent guide is "Answer with GUIDEEDIT7K."

  # Each save records a revision, so the two saves below build the history the
  # scenario then reads, compares and restores from.
  Scenario: Read the history of a document and restore an earlier revision
    When I navigate to the profile page
    And I set the agent guide to "Answer with HISTORYA7K."
    And I note the change as "First rewrite."
    And I save the agent guide
    And I set the agent guide to "Answer with HISTORYB7K."
    And I note the change as "Second rewrite."
    And I save the agent guide
    Then the document history lists 2 revisions
    And the newest revision reads "Second rewrite."
    When I set the agent guide to "An unsaved draft."
    Then the difference removes "Answer with HISTORYA7K." and adds "Answer with HISTORYB7K."
    When I return to the current document
    Then the agent guide draft is "An unsaved draft."
    When I restore the revision that reads "First rewrite."
    Then the stored agent guide is "Answer with HISTORYA7K."
    And the document history lists 3 revisions
    And the newest revision is the restore
    And the restored version matches the current document

  # The agent maintains the other documents through conversation, so the Profile
  # page must not offer them as editable boxes.
  Scenario: The other identity documents stay read-only
    When I navigate to the profile page
    And I open the "Soul" tab
    Then that document is read-only

  Scenario: Configure separate heartbeat and scheduled-task models
    When I navigate to the agent detail page
    And I set the heartbeat model to "hb-web-model"
    Then the stored heartbeat model override is "hb-web-model"
    When I set the scheduled-task model to "cron-web-model"
    Then the stored scheduled-task model override is "cron-web-model"
    When I clear the heartbeat model override
    Then the heartbeat model override is empty and falls back to the main model
    When I clear the scheduled-task model override
    Then the scheduled-task model override is empty and falls back to the main model
