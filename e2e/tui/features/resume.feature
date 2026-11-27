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

  Scenario: Resuming by id opens that thread with no picker
    Given two prior conversation threads exist
    When I launch the CLI with --resume and the older thread's id
    Then that thread becomes the active conversation
    And the resume picker is not shown

  Scenario: Resuming an unknown id exits with an error
    Given a prior conversation thread exists
    When I launch the CLI with --resume and an unknown id
    Then the CLI reports that no conversation has that id
    And the CLI shuts down with a non-zero exit code

  Scenario: --continue opens the most recently updated thread of the directory
    Given two prior conversation threads exist in one directory
    And the older thread was updated last
    When I launch the CLI with --continue in that directory
    Then that thread becomes the active conversation
    And the resume picker is not shown

  Scenario: --continue in a directory without a thread exits with an error
    Given a prior conversation thread exists
    When I launch the CLI with --continue in a directory without a thread
    Then the CLI reports that there is no conversation to continue
    And the CLI shuts down with a non-zero exit code
