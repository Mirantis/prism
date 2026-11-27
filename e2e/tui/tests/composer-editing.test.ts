/**
 * Composer editing keys through a real PTY: the escape sequences a terminal
 * sends for row, line and word moves, history recall with the draft kept, and
 * the popup's claim on Up and Down. Each scenario submits the edited draft and
 * reads the USER row the runtime stored, because the PTY buffer keeps every
 * frame and so shows text that was later edited away.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { expect } from 'vitest';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { BOOT_FRAME_TIMEOUT_MS, startPrism, KEYS, type TuiSession } from '../harness';
import {
  resetThread,
  setupRuntime,
  waitForMessageCount,
  waitForStoredMessage,
  type RuntimeTestEnv,
} from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/composer-editing.feature'), 'utf8'),
);

// The sequences a terminal sends for the editing keys.
const SEQ = {
  HOME: '\x1b[H',
  CTRL_A: '\x01',
  CTRL_E: '\x05',
  OPTION_LEFT: '\x1b[1;3D',
  META_B: '\x1bb',
  CTRL_LEFT: '\x1b[1;5D',
  CTRL_J: '\n',
} as const;

let env: RuntimeTestEnv;
let session: TuiSession;

// One key per write, with a pause: keys that arrive in one stdin chunk all read
// the cursor as it was before the chunk.
async function press(...keys: string[]): Promise<void> {
  for (const key of keys) {
    session.send(key);
    await new Promise((r) => setTimeout(r, 150));
  }
}

function storedUserTexts(): string[] {
  const db = new Database(env.dbPath, { readonly: true });
  try {
    const rows = db
      .prepare("SELECT content FROM conversation_messages WHERE role = 'USER' ORDER BY createdAt")
      .all() as Array<{ content: string }>;
    return rows.map((row) => row.content);
  } finally {
    db.close();
  }
}

// Forty three-character words: wider than the composer at the PTY's 120 columns.
const WRAPPED_LINE = Array.from({ length: 40 }, (_, i) => `w${String(i).padStart(2, '0')}`).join(' ');

describeFeature(feature, ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario }) => {
  BeforeAllScenarios(async () => {
    // The assertions read USER rows, which the runtime stores before the model call, so an
    // invalid key fails each turn at once and no reply lands in a later scenario.
    env = await setupRuntime({ runtimeEnvOverrides: { AWS_BEARER_TOKEN_BEDROCK: 'invalid-e2e-token' } });
  });
  AfterAllScenarios(async () => {
    await env.cleanup();
  });
  BeforeEachScenario(async () => {
    resetThread(env.dbPath);
    session = startPrism({ env: env.prismEnv, runtime: env.runtime });
    await session.waitForFrame(/Prism/, BOOT_FRAME_TIMEOUT_MS);
  });
  AfterEachScenario(async () => {
    await session.stop();
  });

  Scenario('Row, line and word keys edit a two-line draft', ({ When, And, Then }) => {
    When('I type "alpha beta gamma" and "delta epsilon" on two lines', async () => {
      await press('alpha beta gamma', SEQ.CTRL_J, 'delta epsilon');
      await session.waitForFrame('delta epsilon', 5_000);
    });
    And(
      'I edit the draft with Up, Option+Left, Home, Ctrl+E, Down, Meta+B, Ctrl+Left and Ctrl+A',
      async () => {
        // Up keeps the column (13, inside "gamma"); Option+Left goes to the start of "gamma".
        await press(KEYS.UP, SEQ.OPTION_LEFT, 'W');
        await press(SEQ.HOME, 'H');
        await press(SEQ.CTRL_E, 'E');
        // Down lands at the end of the shorter second line.
        await press(KEYS.DOWN, SEQ.META_B, 'M');
        await press(SEQ.CTRL_LEFT, 'C');
        await press(SEQ.CTRL_A, 'A');
      },
    );
    And('I press Enter', async () => {
      await press(KEYS.ENTER);
    });
    Then('the runtime stores "Halpha beta WgammaE\\nAdelta CMepsilon"', async () => {
      await waitForStoredMessage(env.dbPath, 'USER', 'Adelta CMepsilon', 30_000);
      expect(storedUserTexts()).toEqual(['Halpha beta WgammaE\nAdelta CMepsilon']);
    });
  });

  Scenario('Up moves to the first row of a wrapped line', ({ When, And, Then }) => {
    When('I type a line that wraps onto a second row', async () => {
      await press(WRAPPED_LINE);
      await session.waitForFrame('w39', 5_000);
    });
    And('I press Up and type "U"', async () => {
      await press(KEYS.UP, 'U');
    });
    And('I press Enter', async () => {
      await press(KEYS.ENTER);
    });
    Then('the runtime stores the line with "U" on its first row', async () => {
      await waitForStoredMessage(env.dbPath, 'USER', 'w39', 30_000);
      const [text] = storedUserTexts();
      // Without the row move, Up has no history to recall and "U" lands at the end.
      expect(text!.replace('U', '')).toBe(WRAPPED_LINE);
      expect(text!.indexOf('U')).toBeLessThan(WRAPPED_LINE.length / 2);
    });
  });

  Scenario('Up recalls history from a draft and Down brings the draft back', ({ Given, When, And, Then }) => {
    Given('I have sent "first message"', async () => {
      await press('first message', KEYS.ENTER);
      await waitForStoredMessage(env.dbPath, 'USER', 'first message', 30_000);
    });
    When('I type "my draft", press Up and press Enter', async () => {
      await press('my draft', KEYS.UP, KEYS.ENTER);
    });
    Then('the runtime stores "first message" a second time', async () => {
      await waitForMessageCount(env.dbPath, 'USER', 2);
      expect(storedUserTexts()).toEqual(['first message', 'first message']);
    });
    When('I type "second draft", press Up and press Down', async () => {
      await press('second draft', KEYS.UP, KEYS.DOWN);
    });
    And('I type " kept" and press Enter', async () => {
      await press(' kept', KEYS.ENTER);
    });
    Then('the runtime stores "second draft kept"', async () => {
      await waitForMessageCount(env.dbPath, 'USER', 3);
      expect(storedUserTexts()).toEqual(['first message', 'first message', 'second draft kept']);
    });
  });

  Scenario('The popup takes Up and Down, except while I walk history', ({ Given, When, Then, And }) => {
    Given('I have run "/copy"', async () => {
      await press('/copy');
      await session.waitForFrame(/▸\s*\/copy/, 5_000);
      // The first Enter completes the row, the second runs the command.
      await press(KEYS.ENTER, KEYS.ENTER);
      // A failed turn's error reply can be the last message, so any /copy result counts.
      await session.waitForFrame(/No message to copy yet|Copied last message|Failed to copy/, 5_000);
    });
    When('I type a forward slash and press Down', async () => {
      await press('/', KEYS.DOWN);
    });
    Then('the popup highlights a command other than /copy', async () => {
      await session.waitForFrame(/▸\s*\/(?!copy)[a-z-]+/, 5_000);
    });
    When('I clear the composer, type "kept draft", press Up and press Down', async () => {
      // Up recalls "/copy", which opens the popup; Down has to come back to the draft.
      await press(KEYS.BACKSPACE, 'kept draft', KEYS.UP, KEYS.DOWN);
    });
    And('I press Enter', async () => {
      await press(KEYS.ENTER);
    });
    Then('the runtime stores "kept draft"', async () => {
      await waitForStoredMessage(env.dbPath, 'USER', 'kept draft', 30_000);
      expect(storedUserTexts()).toEqual(['kept draft']);
    });
  });
});
