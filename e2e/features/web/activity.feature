Feature: Activity page
  As a user I want to see what the agent has spent and what it has done, so I
  can tell where its tokens went, which webhooks fired and which tools it used

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: The page is reachable from the nav and starts empty
    When I navigate to the activity page
    Then the Activity nav item comes after Profile
    And the token totals are all zero
    And the cache hit rate is not reported
    And the webhook run list says there are none yet
    And the tool call list says there are none yet

  Scenario: A completed turn shows up as usage and as tool calls
    When a chat turn that uses a tool completes
    And I navigate to the activity page
    Then the token totals are above zero
    And the totals match the recorded model calls
    And the gate calls the turn made are counted too
    And the tool call list is not empty
    And the newest stored tool call is listed first
    When I expand the newest tool call
    Then its parameters are shown

  Scenario: The list pages as it is scrolled
    Given the agent has 40 stored tool calls
    When I navigate to the activity page
    Then 30 tool calls are listed
    When I scroll to the end of the tool call list
    Then all 40 tool calls are listed
    And no tool call is listed twice

  Scenario: Webhook runs are listed newest first with their result
    Given the agent has a completed, a failed and a spending-limit webhook run
    When I navigate to the activity page
    Then the webhook runs read newest first:
      | name         | result                 |
      | budget-hook  | Spending limit reached |
      | nightly-sync | Failed                 |
      | deploy-hook  | Completed              |
    When I expand the webhook run "nightly-sync"
    Then the webhook run shows the error "The runtime restarted before the run finished."
    When I expand the webhook run "deploy-hook"
    Then its delivered message contains "Deploy finished."
    And the webhook run lists 2 tool calls

  Scenario: Autonomous turns are labelled by what triggered them
    Given the agent has a stored tool call from a scheduled task
    When I navigate to the activity page
    Then a tool call is labelled Scheduled
