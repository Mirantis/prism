import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SUBSCRIPTION_SETTINGS } from '../lib/coding-agents/claude-code/authenticated-home';
import { notSignedInMessage } from '../lib/coding-agents/subscription';
import { main } from './coding-agent-exec';

/**
 * A fake `claude` on the PATH: answers `auth status` with $FAKE_STATUS, and
 * otherwise records its arguments and Bedrock switch in $FAKE_OUT.
 */
const FAKE_CLAUDE = `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = status ]; then printf '%s' "$FAKE_STATUS"; exit 0; fi
printf '%s\\n' "bedrock=$CLAUDE_CODE_USE_BEDROCK" "$@" > "$FAKE_OUT"
exit 7
`;

describe('coding-agent-exec', () => {
  let dir: string;
  let bin: string;
  let wrappers: string;
  let out: string;
  let databaseUrl: string;
  let errors: string[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-exec-'));
    bin = path.join(dir, 'bin');
    wrappers = path.join(dir, 'wrappers');
    out = path.join(dir, 'out');
    fs.mkdirSync(bin);
    fs.mkdirSync(wrappers);
    fs.writeFileSync(path.join(bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    // Found first on the PATH, as the wrapper is: it must not run itself.
    fs.writeFileSync(path.join(wrappers, 'claude'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
    const file = path.join(dir, 'agent.db');
    const db = new Database(file);
    db.exec('CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER)');
    db.close();
    databaseUrl = `file:${file}`;
    errors = [];
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const switchOn = () => {
    const db = new Database(databaseUrl.slice('file:'.length));
    db.prepare("INSERT INTO runtime_state VALUES ('codingAgentSubscription:claude-code', 'on', 0)").run();
    db.close();
  };

  const run = (args: string[], env: NodeJS.ProcessEnv = {}) =>
    main(['claude', ...args], {
      PATH: `${wrappers}${path.delimiter}${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`,
      PRISM_CODING_AGENT_WRAPPERS: wrappers,
      CLAUDE_CODE_USE_BEDROCK: '1',
      DATABASE_URL: databaseUrl,
      FAKE_OUT: out,
      ...env,
    }, { stdio: 'ignore', stderr: (line) => errors.push(line) });

  const recorded = () => fs.readFileSync(out, 'utf8').trim().split('\n');

  it("runs on the deployment's models with the switch off, and passes the exit code on", async () => {
    expect(await run(['-p', 'hi'])).toBe(7);
    expect(recorded()).toEqual(['bedrock=1', '-p', 'hi']);
    expect(errors).toEqual([]);
  });

  it('runs on the subscription alone with the switch on and the subscription signed in', async () => {
    switchOn();
    const status = JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' });
    expect(await run(['-p', 'hi'], { FAKE_STATUS: status })).toBe(7);
    expect(recorded()).toEqual(['bedrock=', '--settings', SUBSCRIPTION_SETTINGS, '-p', 'hi']);
  });

  it('refuses with the switch on and nobody signed in, as a task does', async () => {
    switchOn();
    expect(await run([], { FAKE_STATUS: JSON.stringify({ loggedIn: false }) })).toBe(1);
    expect(fs.existsSync(out)).toBe(false);
    expect(errors).toEqual([notSignedInMessage('claude-code')]);
  });

  it('lets the person sign in from the terminal with the switch on', async () => {
    switchOn();
    expect(await run(['auth', 'login'], { FAKE_STATUS: JSON.stringify({ loggedIn: false }) })).toBe(7);
    expect(recorded()).toEqual(['bedrock=', 'auth', 'login']);
  });

  it("says so and uses the deployment's models when the setting can't be read", async () => {
    expect(await run([], { DATABASE_URL: `file:${path.join(dir, 'gone.db')}` })).toBe(7);
    expect(recorded()).toEqual(['bedrock=1']);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/^claude: could not read the Coding agents setting .*; using the deployment's models$/);
  });

  it('answers 127 when the real binary is not installed', async () => {
    fs.rmSync(path.join(bin, 'claude'));
    expect(await run([])).toBe(127);
    expect(errors).toEqual(['claude: command not found']);
  });
});
