Feature: CLI inbound file sharing (/attach)
  As a user I want to attach a local file so the agent can read its contents

  Scenario: Attaching a file lets the agent read its contents
    Given a local file containing "The launch code is ZEBRA42."
    When I attach the file
    And I ask "What launch code is written in the attached file? Reply with only the code, no other text."
    Then my message appears in the chat
    And the agent reply contains "ZEBRA42"

  Scenario: Attaching a zip file lets the agent inspect its contents
    Given a local zip file containing a text file "manifest.txt" with "PRISMZIPTUI55"
    When I attach the file
    And I ask "What text file is inside the attached zip and what is its content? Reply with the filename and content only."
    Then my message appears in the chat
    And the agent reply contains "manifest.txt"
    And the agent reply contains "PRISMZIPTUI55"
