/**
 * Skills slash command e2e for the two paths the CLI owns: the `/skills list`
 * alias and the unknown-skill report. The CLI parses both and renders what the
 * runtime answers — the listing from `GET /agents/skills`, the report from the
 * 404 of `POST /agents/skills/:name/run` — so neither makes an LLM call.
 * Running a skill end to end is the web suite's job
 * (`e2e/features/web/skills.feature`).
 *
 * The runtime is booted with PRISM_DATA_DIR pointed at a hermetic temp dir we
 * seed with two SKILL.md bundles before boot, so the catalog holds them from
 * the first request. Nothing here runs a skill, so the bundle bodies are not
 * exercised; they match the web suite's fixture (playwright.config.ts) rather
 * than diverging from it.
 *
 * Written with @amiceli/vitest-cucumber (features/skills.feature).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/skills.feature'), 'utf8'),
);

let env: RuntimeTestEnv;
let session: TuiSession;
let dataDir: string;

function writeSkill(skillsDir: string, name: string, description: string, body: string): void {
  const dir = join(skillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`);
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
      // Hermetic data dir, seeded before the runtime boots so the skills are in
      // the catalog from the first request.
      dataDir = mkdtempSync(join(tmpdir(), 'tui-e2e-skills-'));
      const skillsDir = join(dataDir, 'skills');
      mkdirSync(skillsDir, { recursive: true });
      writeSkill(
        skillsDir,
        'echo-marker',
        'Reply with a fixed test marker.',
        'When this skill is invoked, reply with exactly the following text and nothing else:\n\nSKILL_RAN_OK',
      );
      writeSkill(skillsDir, 'greeting', 'Greet the user warmly.', 'Greet the user warmly in one short sentence.');

      env = await setupRuntime({ runtimeEnvOverrides: { PRISM_DATA_DIR: dataDir } });
    });
    AfterAllScenarios(async () => {
      await env.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    });
    BeforeEachScenario(async () => {
      resetThread(env.dbPath);
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
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
        // Listing is deterministic; the headroom is for a slow CI frame.
        await session.waitForFrame(text, 45_000);
      });
    });

    Scenario('/skills list shows the installed skills with their descriptions', () => {
      // Covered by the shared steps.
    });
    Scenario('/skills run with an unknown skill reports it', () => {
      // Covered by the shared steps.
    });
  },
);
