Feature: Voice messages in the browser
  As a user I want to speak a message instead of typing it, so the words I said
  arrive in the chat without the agent talking back

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A voice message from the composer arrives in the thread as my words
    Given I open a fresh chat
    And the voice model has heard nothing yet
    When I record a voice message from the composer
    And I send the voice message
    Then my transcribed words appear in the thread as my message
    And the voice model transcribed one dictation and was asked for no answer
    And the voice model has no session open

  Scenario: A discarded voice message sends nothing
    Given I open a fresh chat
    And the voice model has heard nothing yet
    When I record a voice message from the composer
    And I discard the voice message
    Then the composer offers the text field again
    And the voice model opened a session and transcribed nothing
    And the voice model has no session open
