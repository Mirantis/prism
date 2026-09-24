Feature: Dictation over the chat connection
  As a user of a voice client I want to speak a message instead of typing it, so
  the words I said arrive in the chat without the agent talking back

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A dictation sends the microphone to the transcriber and answers its transcript
    Given I open a fresh chat
    And the voice model has heard nothing yet
    When I dictate a second of speech on the chat connection and release
    Then the runtime answers the transcript of that second
    And the voice model transcribed one dictation and was asked for no answer
    And the voice model has no session open

  Scenario: A cancelled dictation sends nothing back
    Given I open a fresh chat
    And the voice model has heard nothing yet
    When I dictate a second of speech on the chat connection and cancel it
    Then the runtime answers no transcript
    And the voice model opened a session and transcribed nothing
    And the voice model has no session open
