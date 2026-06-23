import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@/api/errors';
import type { SlashCommand } from './types';

export const skillsCommand: SlashCommand = {
  name: '/skills',
  description: 'List available skills, or run one (/skills [list] | /skills run <name>)',
  run: async (ctx) => {
    const sub = ctx.args[0];
    try {
      if (!sub || sub === 'list') {
        // Pass the active thread so the runtime includes any workspace skills
        // (web threads have no workspaceRoot, so this returns global skills).
        const skills = await runtimeApi.listSkills(ctx.threadId);
        if (skills.length === 0) {
          return 'No skills available. Drop SKILL.md bundles into the agent’s skills directory.';
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
        const result = await runtimeApi.runSkill(name, ctx.threadId);
        return `▶ Running skill "${result.skill}"…`;
      }
      return 'Usage: /skills [list] | /skills run <name>.';
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
