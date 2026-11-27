Feature: The terminal resumes the conversation after it restarts
  As a user of a terminal that restores its tabs I want prism to come back on the same conversation
  so that I do not pick it again by hand

  Scenario: The CLI reports a command that reopens the conversation
    Given a terminal that supports program resume
    When I launch the CLI in a project directory
    Then the CLI reports a signed resume command for its conversation and directory
    And the reported command reopens that conversation

  Scenario: Exiting with /exit clears the record
    Given a terminal that supports program resume
    When I launch the CLI in a project directory
    And I exit the CLI with /exit
    Then the CLI clears its resume record

  Scenario: A termination keeps the record
    Given a terminal that supports program resume
    When I launch the CLI in a project directory
    And the terminal terminates the CLI
    Then the CLI does not clear its resume record

  Scenario: A terminal without program resume receives no report
    Given a terminal without program resume
    When I launch the CLI in a project directory
    Then the CLI writes no resume report

  Scenario: Ctrl+C while the CLI waits for the runtime clears the record
    Given a terminal that supports program resume, and a runtime that does not answer
    When I resume a conversation by id
    And I press Ctrl+C while the CLI waits for the runtime
    Then the CLI clears its resume record
