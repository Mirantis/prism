Feature: Skills
  Installed Agent Skills (the agentskills.io SKILL.md standard) are listed for
  the agent with name + description. `e2e/features/web/skills.feature` covers
  `/skills` and `/skills run` end to end, so what is left here is what only the
  CLI parses: the `list` alias and the unknown-skill path.

  Scenario: /skills list shows the installed skills with their descriptions
    When I run "/skills list"
    Then I see "echo-marker"
    And I see "Reply with a fixed test marker"
    And I see "greeting"

  Scenario: /skills run with an unknown skill reports it
    When I run "/skills run nope"
    Then I see "No available skill named"
