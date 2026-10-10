/**
 * Skills tools — direct AI SDK tools (no MCP round trip).
 *
 * Implements the "level 2" of progressive disclosure: the model sees only each
 * skill's name + description in the system prompt (the `# Skills` section), and
 * calls the `skill` tool to load a skill's full SKILL.md body on demand. The
 * same body-loading path backs the CLI's manual `/skills run`.
 */

import { Tool, tool } from 'ai';
import { z } from 'zod';
import { skillCatalogService } from '../../services/skill-catalog.service';

export const SKILL_TOOL_NAME = 'skill';

/**
 * Build the skills tool set. `workspaceRoot` (the thread's repo dir, when set)
 * merges that repo's skills with the global ones. Returns an empty object when
 * no skills are available, so the tool isn't offered when there's nothing it
 * could load.
 */
export async function getSkillTools(workspaceRoot?: string): Promise<Record<string, Tool>> {
  if ((await skillCatalogService.getCatalog(workspaceRoot)).length === 0) return {};

  return {
    [SKILL_TOOL_NAME]: tool({
      description:
        'Load the full instructions for an available Agent Skill by name, then follow them. ' +
        'The available skills (name + one-line description) are listed in the "# Skills" section ' +
        'of your system prompt. Call this only when a skill is relevant to the current task. ' +
        "Don't guess a skill's contents from its description.",
      inputSchema: z.object({
        name: z.string().describe('The skill name, exactly as shown in the # Skills list'),
      }),
      execute: async ({ name }) => {
        const found = await skillCatalogService.getSkillBody(name, workspaceRoot);
        if (!found) {
          return {
            error: `No available skill named "${name}".`,
            availableSkills: (await skillCatalogService.getCatalog(workspaceRoot)).map((s) => s.name),
          };
        }
        const { entry, body } = found;
        return {
          name: entry.name,
          skillDir: entry.dir,
          skillMdPath: entry.skillMdPath,
          instructions:
            `[Skill: ${entry.name} — directory: ${entry.dir}]\n` +
            `Bundled files (scripts/, references/, assets/) live under that directory; ` +
            `read or run them with the shell tools using that absolute base. ` +
            `Now follow these instructions:\n\n` +
            body,
        };
      },
    }),
  };
}
