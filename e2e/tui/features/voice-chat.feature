Feature: Voice chat in the terminal
  Scenario: Talk, mute, and end a call
    Given a terminal with virtual input and output audio
    When I open the voice panel
    Then the microphone waits for Enter
    When I start the call
    Then audio flows in both directions
    When I mute the microphone
    Then microphone audio stops and the call stays live
    When I unmute the microphone
    Then microphone audio resumes
    When I leave the voice panel
    Then the voice session ends and text commands still work

  Scenario: Audio devices are unavailable
    Given a terminal without audio devices
    When I ask for command help
    Then voice chat is hidden and text commands still work
    When I type the unavailable voice command
    Then the terminal explains the audio requirement locally

  Scenario: An audio device disappears during a call
    Given a terminal with virtual input and output audio
    When I open the voice panel
    And I start the call
    Then audio flows in both directions
    When the audio server stops
    Then the call ends with an audio error
