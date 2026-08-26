Feature: CLI outbound file sharing (/save)
  As a user I want the agent to create a file and share it,
  then save it to local disk with /save

  Scenario: The agent shares a created file and /save writes it to disk
    When I ask the agent to create and share "greeting.txt" containing "PRISMSHARE_TUI_7"
    Then the shared file appears with a save hint
    When I run /save into a local directory
    Then "greeting.txt" is written to disk containing "PRISMSHARE_TUI_7"
    When I ask the agent to change it to "PRISMSHARE_TUI_8" and share it again
    Then "greeting.txt" is saved again containing "PRISMSHARE_TUI_8" and not "PRISMSHARE_TUI_7"
