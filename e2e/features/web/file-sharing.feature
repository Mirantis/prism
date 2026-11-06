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

  # The image is placed by its path, and the text file is shared as a download,
  # so one reply shows both. The reload reads the placement back from history.
  @slow
  Scenario: The agent shows an image inside its reply and shares a file under it
    When I navigate to the agent chat page
    And I type "Run this exact shell command: printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAABgAAAAYCAIAAABvFaqvAAAAH0lEQVR4nGNQTX5NFcQwatCoQaMGjRo0atCoQQNvEABZoULu4chlggAAAABJRU5ErkJggg==' | base64 -d > chart.png. Then create a file named notes.txt containing PRISMNOTES and share it with me as a download. Reply in three lines: the word PRISMBEFORE, then the image chart.png shown inside your reply, then the word PRISMAFTER." in the chat input
    And I send the message
    Then the agent's message should show an image between "PRISMBEFORE" and "PRISMAFTER"
    And I should see "notes.txt" as an attachment on the agent's message
    And I should not see "chart.png" as an attachment on the agent's message
    When I reload the chat page
    Then the agent's message should show an image between "PRISMBEFORE" and "PRISMAFTER"

  # @slow (playwright-bdd → test.slow(), i.e. 3× the configured timeout): the
  # hydrate-first flow costs ~3 inference round-trips (metadata stub →
  # hydrate_attachment → shell read → final text) where auto-inlining cost one.
  # ~26s locally, so nothing here is near the 120s scenario cap today; the
  # headroom is because that cap applies to the *sum* of the steps while each
  # individual wait is already capped at 60s. On a slow CI run that makes the
  # difference between reporting the failing assertion and reporting a
  # scenario-level timeout, which says nothing about what broke.
  @slow
  Scenario: The agent hydrates a ZIP and reports its contents
    When I navigate to the agent chat page
    And I attach a zip file named "bundle.zip" containing a file "secret.txt" with "PRISMZIP99"
    And I type "What text file is inside the attached zip archive and what does it contain? Reply with the filename and its exact content." in the chat input
    And I send the message
    Then I should see "bundle.zip" as an attachment on my message
    And the agent response should contain "secret.txt"
    And the agent response should contain "PRISMZIP99"

  # Two round-trips (stub → view_attachment → final text); same reasoning as above.
  @slow
  Scenario: The agent views an uploaded image
    When I navigate to the agent chat page
    And I attach a small PNG image named "pixel.png"
    And I type "I attached an image. Use view_attachment to look at it, then confirm you can see it by replying with the word IMAGEVIEWED." in the chat input
    And I send the message
    Then I should see "pixel.png" as an attachment on my message
    And the agent response should contain "IMAGEVIEWED"

  # Two round-trips (stub → view_attachment, which attaches the PDF as a
  # document → final text); same reasoning as the zip scenario above.
  @slow
  Scenario: The agent reads an uploaded PDF via view_attachment
    When I navigate to the agent chat page
    And I attach a small PDF named "brief.pdf" containing the text "PRISMPDF77"
    And I type "Use view_attachment on the attached PDF and reply with the exact code word printed in it, nothing else." in the chat input
    And I send the message
    Then I should see "brief.pdf" as an attachment on my message
    And the agent response should contain "PRISMPDF77"

  Scenario: An expired attachment is marked expired and no longer downloads
    When I navigate to the agent chat page
    And I attach a text file named "old-report.txt" containing "stale payload PRISMOLD1"
    And I send the message
    And I wait for the agent to finish responding
    When the content of the attachment "old-report.txt" is expired by the retention sweep
    And I reload the chat page
    Then the attachment "old-report.txt" on my message should be marked expired
    And requesting the attachment "old-report.txt" over HTTP should answer 410
