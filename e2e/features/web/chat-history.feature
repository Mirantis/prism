Feature: Reading back a long conversation
  As a user with a long conversation I want older messages to load as I scroll up
  so that I can read the whole history without the page loading all of it at once

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Scrolling up loads older messages above the one I was reading
    Given a conversation with 120 numbered messages, where the first 70 show an image
    When I navigate to the agent chat page
    Then I should see the message "Message 120" in the conversation
    And I should not see the message "Message 001" in the conversation
    When I scroll up to the oldest message shown
    Then older messages appear above the message I was reading, which stays in place
    When I scroll to the start of the conversation
    Then the conversation shows all 120 numbered messages in order
