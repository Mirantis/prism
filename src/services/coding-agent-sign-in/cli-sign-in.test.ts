import { describe, expect, it, vi } from 'vitest';
import { FakeChild } from '../../test-utils/fake-child';
import { fakeExecutionEnvironment } from '../../test-utils/fake-execution-environment';
import { readPrompt, signInCommand, startCliSignIn } from './cli-sign-in';

// What Claude Code 2.1 prints with stdin piped: the link wrapped in an OSC 8 hyperlink.
const CLAUDE_OUTPUT =
  "If the browser didn't open, visit: \x1b]8;;https://claude.com/cai/oauth/authorize?code=true&client_id=test\x07https://claude.com/cai/oauth/authorize?code=true&client_id=test\x1b]8;;\x07\nPaste code here if prompted > ";
// What Codex 0.156 prints for a device sign-in, coloured.
const CODEX_OUTPUT =
  'Follow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\n\n2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\n   \x1b[94mTEST-CODE1\x1b[0m\n';

describe('readPrompt', () => {
  it("reads Claude's link out of its hyperlink", () => {
    expect(readPrompt('claude-code', CLAUDE_OUTPUT)).toEqual({
      url: 'https://claude.com/cai/oauth/authorize?code=true&client_id=test',
      userCode: null,
    });
  });

  it("reads Codex's link and one-time code", () => {
    expect(readPrompt('codex', CODEX_OUTPUT)).toEqual({ url: 'https://auth.openai.com/codex/device', userCode: 'TEST-CODE1' });
  });

  it('waits for the code Codex prints after its link', () => {
    expect(readPrompt('codex', CODEX_OUTPUT.slice(0, CODEX_OUTPUT.indexOf('2.')))).toBeNull();
  });
});

describe('signInCommand', () => {
  it("signs Claude in to the task home, without the variables that outrank its login", () => {
    const { command, args, env } = signInCommand('claude-code', { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_API_KEY: 'k', PATH: '/bin' }, '/data/.claude');
    expect([command, ...args]).toEqual(['claude', 'auth', 'login', '--claudeai']);
    expect(env).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/data/.claude', BROWSER: 'false', DISABLE_AUTOUPDATER: '1' });
  });

  it('signs Codex in to the task home, in the credential store tasks read', () => {
    const { command, args, env } = signInCommand('codex', { OPENAI_API_KEY: 'k', PATH: '/bin' }, '/data/.codex');
    expect([command, ...args]).toEqual(['codex', 'login', '--device-auth', '-c', 'cli_auth_credentials_store="file"']);
    expect(env).toEqual({ PATH: '/bin', CODEX_HOME: '/data/.codex' });
  });
});

describe('startCliSignIn', () => {
  const start = (agent: 'claude-code' | 'codex') => {
    const child = new FakeChild();
    const runProgram = vi.fn(() => child.asExecProcess());
    const sign = startCliSignIn(fakeExecutionEnvironment({ runProgram }), agent, '/home');
    return { child, sign, runProgram };
  };

  it("types Claude's code into the waiting command, and ends when it exits", async () => {
    const { child, sign } = start('claude-code');
    child.stdout.write(CLAUDE_OUTPUT);
    await expect(sign.prompt).resolves.toMatchObject({ userCode: null });
    const typed: string[] = [];
    child.stdin.on('data', (chunk: Buffer) => typed.push(chunk.toString()));
    sign.submitCode('test-code#state');
    await new Promise((resolve) => setImmediate(resolve));
    expect(typed.join('')).toBe('test-code#state\n');
    child.finish(0);
    await expect(sign.ended).resolves.toBe('exited');
  });

  it('ends at once on a refused code, since the CLI keeps waiting for another', async () => {
    const { child, sign } = start('claude-code');
    child.stdout.write(CLAUDE_OUTPUT);
    await sign.prompt;
    sign.submitCode('wrong');
    child.stderr.write('Invalid code. Please make sure the full code was copied.\n');
    await expect(sign.ended).resolves.toBe('invalid_code');
    expect(child.killed).toBe(true);
  });

  it('rejects the prompt when the command ends before its link', async () => {
    const { child, sign } = start('codex');
    child.finish(1);
    await expect(sign.prompt).rejects.toThrow('ended before it showed a link');
    await expect(sign.ended).resolves.toBe('failed');
  });
});
