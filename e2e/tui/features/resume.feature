Feature: Resuming a previous conversation with --resume
  As a user I want to pick a previous conversation to continue instead of starting fresh

  Scenario: The picker lists prior sessions with their workspace
    Given two prior conversation threads exist
    When I launch the CLI with --resume
    Then the resume picker lists both sessions
    And a session is labelled with its git branch

  Scenario: Selecting a session resumes that thread
    Given two prior conversation threads exist
    When I launch the CLI with --resume
    And I move down and select the older session
    Then that thread becomes the active conversation

  Scenario: Escape leaves the picker and exits cleanly
    Given a prior conversation thread exists
    When I launch the CLI with --resume
    And I press Escape in the picker
    Then the CLI shuts down with exit code 0

  Scenario: Nothing to resume exits with a message
    Given no prior conversation threads exist
    When I launch the CLI with --resume
    Then the CLI reports there are no sessions to resume
    And the CLI shuts down with exit code 0
