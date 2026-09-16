Feature: The agent's computer in the browser
  As a user I want a page where my agent has a computer, so I can watch it work and
  talk to it about what is on the screen

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The page shows the desktop and starts voice only when requested
    Given the runtime can give the agent a computer
    And the voice model has heard nothing yet
    When I open the Computer page
    Then Computer opens without starting voice
    And the agent's screen is being drawn
    When I start voice on Computer
    Then the page says the computer is live
    And the agent's screen is being drawn
    And the voice model hears nothing, because the microphone starts muted
    When I unmute the microphone on the Computer page
    Then the voice model hears my microphone from the Computer page
    And the agent's voice is playing on the Computer page
    # The microphone is open by now, so the silence below is the recording taking it
    # rather than a mute: the agent must not answer over a demonstration.
    When I record my screen for a few seconds
    Then the voice model hears nothing while the recording runs
    When I stop the recording
    Then the voice model is given my screen and my voice from the recording
    When I leave the Computer page
    Then the voice model has no session open
    # A call from the composer is the observable proof that the computer released the one
    # voice: the runtime refuses a second call while it holds a session, whoever asked.
    When I start a voice chat from the composer
    Then the composer says a voice chat is live
    When I end the voice chat
    Then the voice model has no session open

  Scenario: A blocked sign-in allows independent work and resumes after user help
    Given the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    When I ask Prism to read my inbox and the public notes using its computer
    Then Prism requests computer help and reports the public notes
    When I open the Computer help request
    Then Computer keeps help beside the screen and adapts to smaller displays
    When I sign in through the live computer
    Then Prism continues the original conversation and reports the inbox

  Scenario: Human control pauses queued work and survives closing the viewer
    Given the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    When I take control of Computer and open another viewer
    Then the other viewer can watch but cannot take control
    When I ask for the public notes in a chat while I have control
    Then the chat shows that it is waiting for the computer
    And an invalid help continuation keeps my control and the chat waiting
    When I close the controlling viewer and continue from the other viewer
    Then the queued chat reports the public notes

  Scenario: Dismissing sign-in help updates the next conversation turn
    Given the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    When I ask Prism to read my inbox and the public notes using its computer
    Then Prism requests computer help and reports the public notes
    When I dismiss the sign-in request and ask about pending computer help
    Then Prism confirms the sign-in request is closed
