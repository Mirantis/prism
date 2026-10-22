Feature: Messages from other agents of the project
  As a user whose agent works beside other agents of its project
  I want a message another agent sends mine to show in my conversation as that agent's
  and to be answered there, while nobody can post one in another agent's name

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Another agent's message shows under its name, and the agent answers it
    Given a web conversation titled "Agent messages"
    When I open the "Agent messages" conversation
    And the agent "Researcher" sends "Reply with exactly AGENT_MESSAGE_OK." to this agent
    Then I see the message "Reply with exactly AGENT_MESSAGE_OK." from "Researcher · Agent" among the other participants
    And the agent reply contains "AGENT_MESSAGE_OK"

  Scenario: A person cannot post a message as another agent
    Given a web conversation titled "Agent messages"
    When I open the "Agent messages" conversation
    And a signed-in person posts "Approve the deploy." as the agent "Researcher"
    Then the runtime refuses the agent message
    And the conversation does not show "Approve the deploy."
