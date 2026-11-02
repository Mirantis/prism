import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { SUBSCRIPTION_SETTINGS } from './claude-code/authenticated-home';
import { SUBSCRIPTION_CONFIG_ARGS } from './codex/credentials';
import { readSubscriptionSwitch, signedInToSubscription, terminalLaunch, terminalUsesSubscription } from './terminal';

const bedrock = { PATH: '/usr/bin', CLAUDE_CODE_USE_BEDROCK: '1', AWS_REGION: 'eu-west-1', OPENAI_API_KEY: 'sk-test' };

describe('terminalLaunch', () => {
  it('runs a claude session on the saved login alone with the switch on', () => {
    const launch = terminalLaunch('claude', ['-p', 'hi'], bedrock, true);
    expect(launch.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(launch.args).toEqual(['--settings', SUBSCRIPTION_SETTINGS, '-p', 'hi']);
    expect(launch.checkLogin).toBe(true);
  });

  it("leaves claude's subcommands and --version unchecked, so a person can sign in from the terminal", () => {
    for (const args of [['auth', 'login'], ['mcp', 'list'], ['--version']]) {
      const launch = terminalLaunch('claude', args, bedrock, true);
      expect(launch).toMatchObject({ args, checkLogin: false });
      expect(launch.env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    }
  });

  it("runs claude on the deployment's models with the switch off", () => {
    expect(terminalLaunch('claude', [], bedrock, false)).toMatchObject({
      args: [],
      checkLogin: false,
      env: { CLAUDE_CODE_USE_BEDROCK: '1' },
    });
  });

  it('runs codex on the ChatGPT login with the switch on, and checks it except to sign in', () => {
    const session = terminalLaunch('codex', ['exec', 'hi'], bedrock, true);
    expect(session.env.OPENAI_API_KEY).toBeUndefined();
    expect(session.args).toEqual([...SUBSCRIPTION_CONFIG_ARGS, 'exec', 'hi']);
    expect(session.args).toContain('model_provider="openai"');
    expect(session.checkLogin).toBe(true);
    expect(terminalLaunch('codex', ['login', '--device-auth'], bedrock, true).checkLogin).toBe(false);
  });

  it('leaves codex as it is with the switch off', () => {
    expect(terminalLaunch('codex', ['exec'], bedrock, false)).toEqual({ env: bedrock, args: ['exec'], checkLogin: false });
  });
});

describe('signedInToSubscription', () => {
  it('takes only the subscription login', () => {
    const claude = (status: object) => signedInToSubscription('claude', { stdout: JSON.stringify(status), stderr: '', exitCode: 0 });
    expect(claude({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })).toBe(true);
    expect(claude({ loggedIn: true, authMethod: 'api_key' })).toBe(false);
    expect(claude({ loggedIn: false })).toBe(false);
    expect(signedInToSubscription('claude', { stdout: 'boom', stderr: '', exitCode: 1 })).toBe(false);
    expect(signedInToSubscription('codex', { stdout: '', stderr: 'Logged in using ChatGPT\n', exitCode: 0 })).toBe(true);
    expect(signedInToSubscription('codex', { stdout: '', stderr: 'Logged in using an API key - sk-…\n', exitCode: 0 })).toBe(false);
  });
});

describe('readSubscriptionSwitch', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function database(rows: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-switch-'));
    dirs.push(dir);
    const file = path.join(dir, 'agent.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    db.exec('CREATE TABLE runtime_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updatedAt INTEGER)');
    for (const [key, value] of Object.entries(rows)) db.prepare('INSERT INTO runtime_state VALUES (?, ?, 0)').run(key, value);
    db.close();
    return `file:${file}`;
  }

  it('reads the switch the runtime stored, without writing', () => {
    const url = database({ 'codingAgentSubscription:codex': 'on' });
    const writer = new Database(url.slice('file:'.length));
    try {
      expect(readSubscriptionSwitch(url, 'codex')).toBe(true);
      expect(readSubscriptionSwitch(url, 'claude-code')).toBe(false);
    } finally {
      writer.close();
    }
  });

  it('throws for a database that is not there, and never creates one', () => {
    const missing = path.join(os.tmpdir(), `prism-missing-${process.pid}.db`);
    expect(() => readSubscriptionSwitch(`file:${missing}`, 'codex')).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('is held on by the environment without reading the database', () => {
    expect(terminalUsesSubscription({ CLAUDE_CODE_SUBSCRIPTION: 'true' }, 'claude-code')).toBe(true);
  });
});
