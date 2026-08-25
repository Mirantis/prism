Feature: Self-update surfaces
  The e2e runtime runs from source, not a packaged binary, so the updater is
  off — these scenarios pin the disabled-state surfaces on both entry points
  (no LLM call).

  Scenario: /update reports why updates are off in this install
    When I submit the /update command
    Then I see the "updates by other means" notice

  Scenario: prism update exits cleanly when the install cannot self-update
    When I run prism update against the dev runtime
    Then it prints the "updates by other means" notice and exits 0

  Scenario: prism update fails fast when the server is down
    When I run prism update against a stopped server
    Then it prints the unreachable-server message and exits 1
