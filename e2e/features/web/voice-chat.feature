Feature: Voice chat in the browser
  As a user I want to call my agent from the chat page, so I can ask a question by
  voice and hear the answer without typing

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A call carries audio both ways, mutes on request, and gives the voice back when it ends
    Given I open a fresh chat
    And the voice model has heard nothing yet
    When I start a voice chat from the chat header
    Then the chat shows the call is live
    And voice used the managed Azure endpoint and credential
    And the composer cannot record a voice message during the call
    And the voice model hears at least half a second of my microphone
    And the agent's voice is playing in the browser
    When I mute the microphone
    Then the voice model hears no more of my microphone
    When I unmute the microphone
    Then the voice model hears my microphone again
    When I end the voice chat
    Then the chat header offers a new voice call
    And the voice model has no session open
    # A second call is the observable proof that the one voice was released: the
    # runtime refuses a call while it holds a session, whoever asked for it.
    When I reload the chat page
    And I start a voice chat from the chat header
    Then the chat shows the call is live

  Scenario: A call continues the conversation it starts from and leaves a summary in it
    Given I have a conversation with the following messages:
      | role  | content                                  |
      | USER  | The rollout codename is MAPLEKESTREL4    |
      | AGENT | Noted, the rollout codename is MAPLEKESTREL4. |
    And the voice model has heard nothing yet
    When I open my latest conversation
    And I start a voice chat from the chat header
    Then the chat shows the call is live
    And the voice session opened with the conversation holding "User: The rollout codename is MAPLEKESTREL4"
    # The summary is written only for a call where the user spoke.
    And the agent's voice is playing in the browser
    When I end the voice chat
    Then the conversation shows a summary of the call
    And the voice model has no session open

  Scenario: The agent speaks with the voice its name gets
    Given the agent is called "Max"
    And I open a fresh chat
    And the voice model has heard nothing yet
    When I start a voice chat from the chat header
    Then the chat shows the call is live
    And the voice session speaks with "cedar"
    When I end the voice chat
    Then the voice model has no session open
