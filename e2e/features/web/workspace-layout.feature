@workspace-layout
Feature: Workspace layout
  The workspace remains usable with a keyboard and on a small screen.

  Scenario: Overview shortcuts work with a keyboard
    When I open the workspace overview at desktop size
    Then I can open agent settings from the Heartbeat card with Enter

  Scenario: Skip navigation with a keyboard
    When I open the workspace overview at desktop size
    Then the skip link moves focus to the main content

  Scenario: Mobile navigation closes after selecting a page
    When I open the workspace overview at phone size
    And I select Chat from the mobile workspace menu
    Then the mobile workspace menu is closed
    And the chat composer fits in the viewport
    When I select Chat from the mobile workspace menu
    Then the mobile workspace menu is closed

  Scenario Outline: Management pages fit a phone screen
    When I open the workspace page "<path>" at phone size
    Then the workspace content fits without horizontal scrolling
    Examples:
      | path      |
      | /         |
      | /profile  |
      | /channels |
      | /cron     |
      | /webhooks |
      | /activity |

  Scenario: Empty scheduled tasks link to the creation dialog
    When I open the workspace page "/cron" at phone size
    And I choose Create your first task
    Then the task creation form is visible and fits the screen

  Scenario: Chat keeps the composer visible while messages scroll
    When I open the workspace page "/chat" at phone size
    And I run the help command enough times to scroll the conversation
    Then the chat composer fits in the viewport
    And the conversation scrolls inside the workspace
