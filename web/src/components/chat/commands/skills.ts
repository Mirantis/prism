import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@lensapp/prism-client';
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
        const label = (s: (typeof skills)[number]): string => {
          if (s.source === 'workspace') return ' _(workspace)_';
          // `pluginId` is optional on the wire, so fall back rather than
          // rendering "(plugin: undefined)" at the user.
          if (s.source === 'plugin') {
            return s.pluginId ? ` _(plugin: ${s.pluginId})_` : ' _(plugin)_';
          }
          return '';
        };
        // Markdown, not indented plain text: the chat renders system messages
        // through the same markdown pipeline as replies, so single newlines in
        // a plain-text list collapse into one run-on line.
        return [
          `**Available skills** (${skills.length})`,
          '',
          ...skills.map((s) => `- **${s.name}** — ${s.description}${label(s)}`),
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
