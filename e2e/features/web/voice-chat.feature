Feature: Voice chat in the browser
  As a user I want to talk to my agent out loud from the chat page, so I can ask
  a question by voice and hear the answer without typing

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A call carries audio both ways, mutes on request, and gives the voice back when it ends
    Given I open a fresh chat
    And the voice model has heard nothing yet
    When I start a voice chat from the composer
    Then the composer says a voice chat is live
    And voice used the managed Azure endpoint and credential
    And the voice model hears at least half a second of my microphone
    And the agent's voice is playing in the browser
    When I mute the microphone
    Then the voice model hears no more of my microphone
    When I unmute the microphone
    Then the voice model hears my microphone again
    When I end the voice chat
    Then the composer offers a new voice chat
    And the voice model has no session open
    # A second call is the observable proof that the one voice was released: the
    # runtime refuses a call while it holds a session, whoever asked for it.
    When I reload the chat page
    And I start a voice chat from the composer
    Then the composer says a voice chat is live
