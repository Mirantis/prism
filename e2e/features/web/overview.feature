Feature: Overview setup checklist
  As a user I want the Overview to show what I have set up
  and what to do next

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: A new agent starts with its first conversation
    When I navigate to the overview page
    Then the overview shows no LLM provider warning
    And the "conversation" setup step is not done
    And the "conversation" setup step is marked as next

  Scenario: An empty conversation does not count as the first one
    Given a conversation thread rooted at "/work/project-one"
    When I navigate to the overview page
    Then the "conversation" setup step is not done

  Scenario: A step ticks off once it is done, and the next one is marked
    Given a conversation thread titled "Database Schema Migration" rooted at "/work/project-one"
    When I navigate to the overview page
    Then the "conversation" setup step is done
    And the "task" setup step is not done
    And the "task" setup step is marked as next

  Scenario: Only an active recurring task completes the scheduled-task step
    Given a scheduled task "Nudge" with the schedule "in 6 hours"
    When I navigate to the overview page
    Then the "task" setup step is not done
    Given a scheduled task "Morning brief" with the schedule "0 9 * * 1-5"
    When I navigate to the overview page
    Then the "task" setup step is done
    And the scheduled tasks created here are removed
