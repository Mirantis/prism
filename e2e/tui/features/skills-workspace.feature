Feature: Workspace (repository) skills
  Skills from the repository the CLI was started in — its .claude/skills and
  .agents/skills directories — load alongside the global ones, are labeled as
  workspace, and can be run.

  Scenario: /skills lists the repo's workspace skills alongside global ones
    When I run "/skills"
    Then I see "repo-greeter"
    And I see "(workspace)"
    And I see "repo-agent-tool"
    And I see "echo-marker"

  Scenario: a workspace skill can be run and the agent follows it
    When I run "/skills run repo-greeter"
    Then I see "WORKSPACE_SKILL_RAN"
