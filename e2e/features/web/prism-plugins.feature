Feature: Prism plugins
  As a user I want a plugin to add its own page to the web UI, so the agent can
  give me new functionality without a new release

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: An installed plugin becomes a page in the navigation
    When I navigate to the overview page
    Then the navigation lists the costs plugin
    And the costs plugin is listed as an ordinary page, not inside a group
    When I follow the costs plugin in the navigation
    Then the costs plugin page is shown
    And the breadcrumb names the costs plugin

  Scenario: The page renders with Prism's own components and its own data
    When I navigate to the costs plugin page
    Then the page heading reads Costs
    And the page shows the total from the plugin's own endpoint
    And the page shows a row for each service the endpoint returned

  Scenario: The page reaches its own routes and nothing else
    When I navigate to the costs plugin page
    Then the plugin's summary endpoint answers
    And the plugin's data directory is its own
    And a route the plugin does not declare answers not found
    And a file the plugin ships is served

  Scenario: The agent can call a tool a plugin declared
    When I ask the agent for the cost summary
    Then the agent calls the plugin's tool

  Scenario: A plugin whose page will not build says why on its own page
    When I navigate to the broken plugin page
    Then the page reports a build problem
    And the navigation still lists the broken plugin
