Feature: Detachable Agent Computer

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Detaching and restoring the computer keeps the desktop available
    Given the runtime can give the agent a computer
    When I open the Computer page
    And I pop out the computer
    Then the detached computer fills its window and streams the desktop
    And I can move the floating controls and resize the computer window
    When I reload the embedded computer page
    Then the computer offers Focus window and Restore
    When I restore the computer
    Then the embedded computer streams the desktop again
    When I pop out the computer
    And I close the detached computer
    Then the embedded computer streams the desktop again

  Scenario: The detached computer survives closing the main window
    Given the runtime can give the agent a computer
    When I open the Computer page
    And I pop out the computer
    And I close the main computer window
    Then the detached computer fills its window and streams the desktop

  Scenario: A blocked popup keeps the embedded computer available
    Given the runtime can give the agent a computer
    When I open the Computer page
    And the browser blocks the computer popup
    Then the embedded computer streams the desktop again
    And Computer explains how to allow popups
