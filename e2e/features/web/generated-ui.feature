Feature: The agent shows a UI in the conversation
  As a person talking to an agent
  I want tables, charts and buttons when they say more than prose
  so that I can read the answer at a glance and choose with one press

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The agent shows a UI, and a press starts its next turn
    When I navigate to the agent chat page
    And I type "Call show_ui once with a Card titled 'Release status' that holds a Table with the columns 'Service' and 'State' and one row 'api' and 'green', and an Actions with two Buttons labelled 'Ship it' and 'Wait'. After my press, reply with exactly CHOICE_NOTED." in the chat input
    And I send the message
    Then the UI shows a table with the cell "green"
    When I press "Ship it" in the UI
    Then the UI shows "Pressed" under "Ship it"
    And the press shows as my message "Ship it"
    And the agent reply contains "CHOICE_NOTED"

  Scenario: Every component draws, and a second press changes nothing
    Given a conversation with a generated UI
    When I open the conversation with the UI
    Then the UI shows the heading "Deploys this week"
    And the UI shows a table with the cell "api"
    And the UI shows the chart "Deploys per day" with "5" for "Tue"
    And the UI shows the checklist item "Tag the release"
    And the UI shows a link "Runbook" to "https://example.com/runbook"
    When "Grace Åström" presses "Roll back" in the UI first
    Then the UI shows "Pressed by Grace Åström" under "Roll back"
    And another press in the UI is refused with the stored UI
    And the press shows as a message from "Grace Åström": "Roll back"
    And the agent has finished its turn
