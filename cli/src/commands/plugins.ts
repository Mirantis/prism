import { ApiError } from '../api-client.js';
import type { SlashCommand } from './types.js';

export const pluginsCommand: SlashCommand = {
  name: '/plugins',
  description: 'List installed plugins and what each contributes',
  run: async (ctx) => {
    try {
      const plugins = await ctx.api.listPlugins();
      if (plugins.length === 0) {
        return 'No plugins installed. Drop an Agent Plugins directory into the agent’s plugins directory.';
      }
      const lines: string[] = ['Installed plugins:'];
      for (const p of plugins) {
        const version = p.version ? ` v${p.version}` : '';
        lines.push(`  ${p.id}${version}${p.description ? ` — ${p.description}` : ''}`);
        if (p.skills.length > 0) lines.push(`    skills: ${p.skills.join(', ')}`);
        if (p.mcpServers.length > 0) lines.push(`    mcp servers: ${p.mcpServers.join(', ')}`);
        // Surfaced inline so a half-broken plugin is visible here rather than
        // only in the container logs.
        for (const d of p.diagnostics) lines.push(`    ! ${d}`);
      }
      return lines.join('\n');
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
