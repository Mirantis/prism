Feature: Messages from other agents of the project in the terminal
  As a user whose agent works beside other agents on Lens Agents
  I want the terminal to show another agent's message under that agent's name,
  and a notice about my agent's messages under its sender's name

  Scenario: Agent messages show under their senders, as they arrive and after reopening
    Given the CLI shows the agent's conversation
    When the agent "Researcher" sends "Reply with exactly one word: AGENTMSG7. No other text." to this agent
    And "Irene Agent" sends the notice "Your message to Writer could not be delivered: Writer is no longer in your project."
    Then the screen shows a message from "Researcher · Agent"
    And the screen shows a message from "Irene Agent"
    When the agent has answered them
    And I reopen the CLI
    Then the reopened CLI shows a message from "Researcher · Agent"
    And the reopened CLI shows a message from "Irene Agent"
