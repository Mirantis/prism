Feature: Model spending
  As a user I want to know what the agent spent on models for each message I
  sent, each conversation and each day, so I can tell where the money went

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A message I sent is priced, and its spending is listed under its conversation and its day
    When a chat turn that uses a tool completes
    Then the spending of my message is above zero, with every call priced
    And my message is listed in the spending of its conversation
    And today's spending includes my message

  Scenario: The Spending page shows a message I sent, from the month's total down to its calls
    When a chat turn that uses a tool completes
    And I navigate to the activity page
    And I follow the link to the spending page
    Then this month's spending is above zero
    And today's bar in the spending chart is above zero
    And my conversation is listed under top conversations
    When I open my conversation's spending
    Then my message is listed there with its cost
    And the sheet links to my conversation
    When I expand my message's spending
    Then its calls include the agent's replies

  Scenario: The Spending page shows a channel conversation by the names in its mentions
    Given a channel conversation whose message mentions people has spent on models
    When I open the spending page
    Then the channel conversation is listed under top conversations by the names in its title
    When I open the channel conversation's spending
    Then its title and its message show the names in their mentions
    And the sheet has no link to open the conversation
