Feature: The agent asks questions as a card
  As a person talking to an agent
  I want to answer its questions by choosing from a card
  so that I can make several decisions in one step

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The agent asks, and the answers start its next turn
    When I navigate to the agent chat page
    And I type "Call ask_questions once, with one question: text 'Which colour should the banner use?', options 'Green' and 'Blue'. After my answer, reply with exactly COLOUR_NOTED." in the chat input
    And I send the message
    Then a question card waits with "1 question"
    When I choose "Green" on the question card
    And I send the question card
    Then the question card shows "Answered"
    And the conversation shows my answer "Which colour should the banner use? Green"
    And the agent reply contains "COLOUR_NOTED"

  Scenario: Answers become one message, and a blank reads no answer
    Given a conversation with a waiting question card
    When I open that conversation
    Then a question card waits with "3 questions"
    And the question card shows its intro
    And the answer button is disabled
    When I reload the page
    And I choose "Under €500" on the question card
    And I choose "Newsletter" on the question card
    Then the question card status reads "2 of 3 answered"
    When I send the question card
    Then the question card shows "Answered"
    And the question card hides its intro
    When I show the questions on the question card
    Then the question card shows its intro
    And the conversation shows my answer "Budget: Under €500"
    And the conversation shows my answer "Which channels should we use? Newsletter"
    And the conversation shows my answer "Launch: no answer"
    And the agent has finished its turn

  Scenario: A second answer changes nothing
    Given a conversation with a waiting question card
    When I open that conversation
    And I choose "Under €500" on the question card
    And "Grace Åström" answers the question card first
    Then the question card shows "Answered by Grace Åström"
    And the question card says "Grace Åström answered first. Your choices weren’t sent."
    And another answer to the question card is refused with the stored card
    And the agent has finished its turn

  Scenario: Typing a reply closes the card
    Given a conversation with a waiting question card
    When I open that conversation
    And I type "Let us talk about the budget first." in the chat input
    And I send the message
    Then the question card shows "Answered in chat"
    And the agent has finished its turn

  Scenario: A waiting card survives a restart
    Given a conversation with a waiting question card
    When I open that conversation
    And the runtime is killed and starts again
    And I reload the page
    Then a question card waits with "3 questions"
