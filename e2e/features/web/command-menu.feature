Feature: Command palette
  As a user I want to reach any page or conversation by typing
  so that I do not have to hunt through the sidebar

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Open a conversation from the command palette
    Given an older conversation thread rooted at "/work/project-one"
    And a conversation thread titled "Database Schema Migration" rooted at "/work/ignored-folder"
    When I navigate to the profile page
    And I open the command palette
    And I search the command palette for "schema"
    Then the command palette shows 1 result
    And the command palette result is "Database Schema Migration"
    When I open the first command palette result
    Then the URL is a chat thread URL
    And the breadcrumb shows the conversation "Database Schema Migration"
    And the browser tab title is "Database Schema Migration · Test Agent"

  Scenario: Go to a page from the sidebar's Search button
    When I navigate to the agent chat page
    And I open the command palette from the sidebar
    And I search the command palette for "webhooks"
    Then the command palette shows 1 result
    When I open the first command palette result
    Then the URL is the "/webhooks" page
    And the browser tab title is "Webhooks · Test Agent"
