/**
 * The agent's directories on this machine: the data dir's own layout, which
 * an operator can point elsewhere one variable at a time.
 */
import { resolveCodexHome } from '../../coding-agents/codex/credentials';
import { resolveClaudeConfigDir } from '../../coding-agents/claude-code/home';
import { resolvePluginsDir, resolveSkillsDir, resolveToolOutputDir } from '../../data-dir';
import type { AgentPaths } from '../execution-environment';

export function localAgentPaths(): AgentPaths {
  return {
    skillsDir: resolveSkillsDir(),
    pluginsDir: resolvePluginsDir(),
    toolOutputDir: resolveToolOutputDir(),
    claudeHome: resolveClaudeConfigDir(process.env),
    codexHome: resolveCodexHome(process.env),
  };
}
