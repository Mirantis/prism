Feature: A turn the model cannot answer
  As a user I want the chat and the terminal tab to show that the agent could
  not answer when its model call fails

  Scenario: A rejected model credential fails the turn
    When I send a prompt to an agent whose model credential is rejected
    Then the agent replies that it encountered an error
    And the chat shows "The agent could not answer"
    And the terminal is told the turn failed
