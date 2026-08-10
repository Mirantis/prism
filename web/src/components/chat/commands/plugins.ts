import { runtimeApi } from '@/api/runtime-client';
import { ApiError } from '@/api/errors';
import type { PluginSummary } from '@/types';
import type { SlashCommand } from './types';

/** One plugin as a markdown list item, with its contributions nested beneath. */
function renderPlugin(p: PluginSummary): string {
  const version = p.version ? ` \`v${p.version}\`` : '';
  const description = p.description ? ` — ${p.description}` : '';
  const lines = [`- **${p.id}**${version}${description}`];

  if (p.skills.length > 0) {
    lines.push(`    - Skills: ${p.skills.map((s) => `\`${s}\``).join(', ')}`);
  }
  if (p.mcpServers.length > 0) {
    lines.push(`    - MCP servers: ${p.mcpServers.map((s) => `\`${s}\``).join(', ')}`);
  }
  if (p.skills.length === 0 && p.mcpServers.length === 0) {
    lines.push('    - Contributes nothing');
  }
  // Nested so a half-broken plugin reads as one entry with a problem, rather
  // than as noise between the plugins that are fine.
  for (const d of p.diagnostics) lines.push(`    - **Problem:** ${d}`);

  return lines.join('\n');
}

export const pluginsCommand: SlashCommand = {
  name: '/plugins',
  description: 'List installed plugins and what each contributes',
  run: async () => {
    try {
      const plugins = await runtimeApi.listPlugins();
      if (plugins.length === 0) {
        return 'No plugins installed. Drop an Agent Plugins directory into the agent’s plugins directory.';
      }
      // Markdown, not plain text: the chat renders system messages through the
      // same markdown pipeline as replies, so a real list beats an indented blob.
      return [
        `**Installed plugins** (${plugins.length})`,
        '',
        ...plugins.map(renderPlugin),
      ].join('\n');
    } catch (err) {
      if (err instanceof ApiError) return err.message;
      throw err;
    }
  },
};
