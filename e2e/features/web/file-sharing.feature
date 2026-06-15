Feature: Share files with the agent
  As a user I want to share files with my personal agent
  so that it can read attachments I send in chat,
  and receive files the agent creates and shares back

  Background:
    Given I am logged in
    And I have a personal agent

  Scenario: Attach a file and remove it before sending
    When I navigate to the agent chat page
    And I attach a text file named "notes.txt" containing "hello from a file"
    Then I should see "notes.txt" as an attachment in the composer
    When I remove the attachment "notes.txt"
    Then I should not see "notes.txt" as an attachment in the composer

  Scenario: The agent reads an uploaded text file
    When I navigate to the agent chat page
    And I attach a text file named "secret.txt" containing "The secret code is PRISMFILE42."
    And I type "Reply with only the secret code written in the attached file." in the chat input
    And I send the message
    Then I should see "secret.txt" as an attachment on my message
    And the agent response should contain "PRISMFILE42"

  Scenario: A shared file persists across reload and re-downloads on click
    When I navigate to the agent chat page
    And I attach a text file named "report.txt" containing "downloaded payload PRISMDL"
    And I send the message
    And I wait for the agent to finish responding
    And I reload the chat page
    Then I should see "report.txt" as an attachment on my message
    When I download the attachment "report.txt"
    Then the downloaded file should be named "report.txt"
    And the downloaded file should contain "downloaded payload PRISMDL"

  Scenario: The agent creates a file and shares it back as a download
    When I navigate to the agent chat page
    And I type "Create a file named greeting.txt whose exact contents are PRISMSHARE99, then share that file with me so I can download it." in the chat input
    And I send the message
    Then I should see "greeting.txt" as an attachment on the agent's message
    When I download the attachment "greeting.txt"
    Then the downloaded file should be named "greeting.txt"
    And the downloaded file should contain "PRISMSHARE99"

  Scenario: An agent-shared file persists across reload
    When I navigate to the agent chat page
    And I type "Create a file named export.txt whose exact contents are PRISMRELOAD7 and share it with me as a downloadable file." in the chat input
    And I send the message
    Then I should see "export.txt" as an attachment on the agent's message
    When I reload the chat page
    And I download the attachment "export.txt"
    Then the downloaded file should be named "export.txt"
    And the downloaded file should contain "PRISMRELOAD7"
