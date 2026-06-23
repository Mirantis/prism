import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const skillsCommand: SlashCommand = {
  name: '/skills',
  description: 'List available skills, or run one (/skills [list] | /skills run <name>)',
  run: async (ctx) => {
    const sub = ctx.args[0];
    // Pass the active thread so the runtime includes this repo's workspace
    // skills (from its .claude/skills / .agents/skills) in the listing/run.
    const threadId = ctx.threadId ?? undefined;
    try {
      if (!sub || sub === 'list') {
        const skills = await ctx.api.listSkills(threadId);
        if (skills.length === 0) {
          return 'No skills available. Drop SKILL.md bundles into the agent’s skills directory or this repo’s .claude/skills/.';
        }
        return [
          'Available skills:',
          ...skills.map(
            (s) => `  ${s.name} — ${s.description}${s.source === 'workspace' ? ' (workspace)' : ''}`,
          ),
        ].join('\n');
      }
      if (sub === 'run') {
        const name = ctx.args[1];
        if (!name) return 'Usage: /skills run <name>.';
        const result = await ctx.api.runSkill(name, threadId);
        return `▶ Running skill "${result.skill}"…`;
      }
      return 'Usage: /skills [list] | /skills run <name>.';
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
