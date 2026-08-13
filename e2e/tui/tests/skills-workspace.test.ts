/**
 * Workspace (repository) skills e2e.
 *
 * The runtime is booted with a hermetic global skills dir (PRISM_DATA_DIR) that
 * holds `echo-marker`. A separate temp REPO dir is seeded with workspace skills
 * under both `.claude/skills/` (`repo-greeter`) and `.agents/skills/`
 * (`repo-agent-tool`). The CLI is launched with that repo as its cwd, so it
 * sends the repo as the thread's workspaceRoot — the runtime then merges the
 * repo's skills with the global ones.
 *
 * `/skills` (list) is deterministic and asserts both sources appear with the
 * workspace ones labeled. `/skills run repo-greeter` goes through the real
 * conversation engine: the workspace SKILL.md tells the agent to reply with a
 * fixed marker, asserted in the PTY frame — proving repo skills are discovered,
 * listed, loaded by the `skill` tool, followed, and streamed back.
 *
 * Written with @amiceli/vitest-cucumber (features/skills-workspace.feature).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/skills-workspace.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;
let dataDir: string;
let repoDir: string;

function writeSkillMd(skillDir: string, name: string, description: string, body: string): void {
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
  );
}

async function dispatch(line: string): Promise<void> {
  session.send(line);
  await new Promise((r) => setTimeout(r, 300));
  session.send(KEYS.ENTER);
}

describeFeature(
  feature,
  ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario, defineSteps }) => {
    BeforeAllScenarios(async () => {
      // Global skills dir (one skill).
      dataDir = mkdtempSync(join(tmpdir(), 'tui-e2e-skills-global-'));
      writeSkillMd(
        join(dataDir, 'skills', 'echo-marker'),
        'echo-marker',
        'Reply with a fixed test marker.',
        'When invoked, reply with exactly: SKILL_RAN_OK',
      );

      // A fake repo with workspace skills under .claude/skills and .agents/skills.
      repoDir = mkdtempSync(join(tmpdir(), 'tui-e2e-repo-'));
      writeSkillMd(
        join(repoDir, '.claude', 'skills', 'repo-greeter'),
        'repo-greeter',
        'Repo-local greeter.',
        'When this skill is invoked, reply with exactly the following text and nothing else:\n\nWORKSPACE_SKILL_RAN',
      );
      writeSkillMd(
        join(repoDir, '.agents', 'skills', 'repo-agent-tool'),
        'repo-agent-tool',
        'Repo-local agent-standard skill.',
        'A repo skill from the .agents/skills directory.',
      );

      env = await setupRuntime({ runtimeEnvOverrides: { PRISM_DATA_DIR: dataDir } });
    });
    AfterAllScenarios(async () => {
      await env.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
      rmSync(repoDir, { recursive: true, force: true });
    });
    BeforeEachScenario(async () => {
      resetThread(env.dbPath);
      // Launch the CLI *inside the repo* so its thread's workspaceRoot = repoDir.
      session = startPrism({ env: env.prismEnv, runtime: env.runtime, cwd: repoDir });
      await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
    });
    AfterEachScenario(async () => {
      await session.stop();
    });

    defineSteps(({ Step }) => {
      Step('I run {string}', async (_ctx, line: string) => {
        await dispatch(line);
      });
      Step('I see {string}', async (_ctx, text: string) => {
        // Running a skill awaits a full LLM turn; give it generous headroom.
        await session.waitForFrame(text, 45_000);
      });
    });

    Scenario('/skills lists the repo\'s workspace skills alongside global ones', () => {
      // Covered by the shared steps.
    });
    Scenario('a workspace skill can be run and the agent follows it', () => {
      // Covered by the shared steps.
    });
  },
);
