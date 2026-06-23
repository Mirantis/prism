Feature: Skills
  Installed Agent Skills (the agentskills.io SKILL.md standard) are listed for
  the agent with name + description, and can be triggered manually from the CLI.
  Listing and the unknown-skill path are deterministic; running a skill goes
  through the real conversation engine (Bedrock).

  Scenario: /skills lists installed skills with their descriptions
    When I run "/skills"
    Then I see "echo-marker"
    And I see "Reply with a fixed test marker"
    And I see "greeting"

  Scenario: /skills list shows the same listing
    When I run "/skills list"
    Then I see "echo-marker"

  Scenario: /skills run with an unknown skill reports it
    When I run "/skills run nope"
    Then I see "No available skill named"

  Scenario: /skills run loads the skill and the agent follows its instructions
    When I run "/skills run echo-marker"
    Then I see "SKILL_RAN_OK"
