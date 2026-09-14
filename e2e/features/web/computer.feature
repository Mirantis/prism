Feature: The agent's computer in the browser
  As a user I want a page where my agent has a computer, so I can watch it work and
  talk to it about what is on the screen

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The page opens a call with a screen, starts muted, and gives the voice back when I leave
    Given the runtime can give the agent a computer
    And the voice model has heard nothing yet
    When I open the Computer page
    Then the page says the computer is live
    And the agent's screen is being drawn
    And the voice model hears nothing, because the microphone starts muted
    When I unmute the microphone on the Computer page
    Then the voice model hears my microphone from the Computer page
    And the agent's voice is playing on the Computer page
    When I leave the Computer page
    Then the voice model has no session open
    # A call from the composer is the observable proof that the computer released the one
    # voice: the runtime refuses a second call while it holds a session, whoever asked.
    When I start a voice chat from the composer
    Then the composer says a voice chat is live
    When I end the voice chat
    Then the voice model has no session open
