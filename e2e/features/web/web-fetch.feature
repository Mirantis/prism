Feature: Reading web pages
  As a user I want the agent to read a web page I give it
  so that it answers from the page without opening its browser

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The agent reads a public page without its computer
    When I navigate to the agent chat page
    And I ask the agent what the page at "https://example.com" says
    Then the agent reply contains "documentation examples"
    And no reply is an error
    And the agent read the page with web_fetch and no other tool
