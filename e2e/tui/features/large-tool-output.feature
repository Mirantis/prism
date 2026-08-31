Feature: A tool result too large to show whole is saved and searchable
  As a user I want the agent to keep working with a huge tool result
  rather than losing the part it was not shown, and without that result
  costing the conversation again on every later turn

  Scenario: The agent searches the part of a result it was never shown
    Given the agent's workspace holds a file too large to return whole
    When I ask the agent to read that file
    Then the stored tool result is the capped view, not the raw payload
    And the whole output is saved on disk
    And the part it was not shown is absent from what it read
    When I ask the agent what the marker line says
    Then it reads the saved file with the shell rather than fetching again
    And it answers with the marker text
    When I ask an unrelated question in the same conversation
    Then the conversation's context stays far below the size of the raw result
