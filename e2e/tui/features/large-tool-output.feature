Feature: A tool result too large to show whole is saved and searchable
  As a user I want the agent to keep working with a huge tool result
  rather than losing the part it was not shown, and without that result
  costing the conversation again on every later turn

  Scenario: The agent searches the part of a result it was never shown
    Given the agent's workspace holds a file too large to return whole
    When I ask the agent to read that file with the shell
    Then the stored tool result is the capped view, not the raw payload
    And the whole output is saved on disk
    And the part it was not shown is absent from what it read
    When I ask the agent what the marker line says
    Then it searches the saved output rather than re-reading it whole
    And it answers with the marker text

  Scenario: A saved result is not re-sent on every later turn
    When I ask the agent an unrelated question
    Then the conversation's context stays far below the size of the raw result
