@slack
Feature: Computer help from Slack
  Scenario: Sign-in help links to the configured public Computer page
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    When I ask for computer sign-in help from Slack
    Then the Slack help message links to the configured public Computer page

  Scenario: A scheduled task asks for help in Slack and the web, and continues when Slack answers it
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    When a scheduled task that is not tied to a conversation needs a sign-in approved
    Then the help request is posted in the main Slack channel with the Computer link
    And the same help request waits in the web chat
    When another scheduled task that is not tied to a conversation needs the same approval
    Then the help request that is already waiting is not posted again
    When I approve the sign-in on my phone
    And I tell Prism in the Slack thread that I finished helping
    Then the web chat shows the help request answered
    And both scheduled tasks report the approved page in the main Slack channel

  Scenario: A goal started in a Slack thread asks for help in that thread
    Given a test Slack channel exists
    And the bot is invited to the channel
    And I link the channel to the agent via the UI
    And the runtime can give the agent a computer
    And a website with a sign-in page and public notes
    And a conversation with the bot in a Slack thread
    When a goal in that Slack thread needs sign-in help
    Then the goal's help request is posted in that Slack thread only
