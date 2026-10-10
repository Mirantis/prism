/**
 * The `--mcp-config` document a Claude Code task gets: each transport in the
 * CLI's own shape, and a stdio server started in its own directory.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { CodingAgentMcpServer } from '../coding-agent';
import { claudeMcpConfig } from './mcp-config';

type Entry = { type: string; command?: string; args?: string[]; env?: Record<string, string> };

function entries(servers: CodingAgentMcpServer[], viaSh = true): Record<string, Entry> {
  const document = JSON.parse(claudeMcpConfig(servers, viaSh).document) as {
    mcpServers: Record<string, Entry>;
  };
  return document.mcpServers;
}

const PROBE: CodingAgentMcpServer = {
  kind: 'stdio',
  name: 'demo__probe',
  command: 'node',
  args: ['server.js', '--port', '0'],
  env: { PLUGIN_ROOT: '/plugins/demo', TOKEN: 't' },
  cwd: '/plugins/demo',
};

describe('claudeMcpConfig', () => {
  it('writes a remote server as its transport, URL and headers', () => {
    expect(
      entries([
        { kind: 'http', name: 'nexus', url: 'https://nexus.example.test/mcp', headers: {} },
        {
          kind: 'sse',
          name: 'demo__events',
          url: 'https://events.example.test/sse',
          headers: { 'X-Api-Key': 'k' },
        },
      ]),
    ).toEqual({
      nexus: { type: 'http', url: 'https://nexus.example.test/mcp', headers: {} },
      demo__events: {
        type: 'sse',
        url: 'https://events.example.test/sse',
        headers: { 'X-Api-Key': 'k' },
      },
    });
  });

  it('writes a stdio server with its env, started from its own directory', () => {
    const { demo__probe } = entries([PROBE]);
    expect(demo__probe.type).toBe('stdio');
    expect(demo__probe.env).toEqual({ PLUGIN_ROOT: '/plugins/demo', TOKEN: 't' });
    // The server's own command line ends the wrapper's; the cases below run it.
    expect(demo__probe.args?.slice(-5)).toEqual(['/plugins/demo', 'node', 'server.js', '--port', '0']);
  });

  it('writes a stdio server as its own command line where there is no `sh`', () => {
    expect(entries([PROBE], false)).toEqual({
      demo__probe: {
        type: 'stdio',
        command: 'node',
        args: ['server.js', '--port', '0'],
        env: { PLUGIN_ROOT: '/plugins/demo', TOKEN: 't' },
      },
    });
  });

  it('leaves out a server whose values hold text the CLI would replace from its own environment', () => {
    // The forms Claude Code 2.1.296 replaced in a real run: `${NAME}` and
    // `${NAME:-default}`, in an arg, an env value and a header.
    const servers: CodingAgentMcpServer[] = [
      { ...PROBE, name: 'in_arg', args: ['--home=${HOME}'] },
      { ...PROBE, name: 'in_env', env: { KEY: '${TOKEN}' } },
      {
        kind: 'http',
        name: 'in_header',
        url: 'https://remote.example.test/mcp',
        headers: { 'X-Key': 'pre-${TOKEN:-none}-post' },
      },
      // Text the CLI keeps as it is.
      { ...PROBE, name: 'kept', args: ['$HOME', '${1}', '${}'] },
    ];

    const { document, leftOut } = claudeMcpConfig(servers, true);

    expect(leftOut).toEqual(['in_arg', 'in_env', 'in_header']);
    expect(Object.keys(JSON.parse(document).mcpServers)).toEqual(['kept']);
  });

  it('writes no server when the runtime connects none', () => {
    expect(entries([])).toEqual({});
  });
});

describe('a stdio entry run as the CLI runs it', () => {
  let serverDir: string;

  beforeEach(() => {
    // A space and a quote in the name, which the wrapper takes as an argument.
    serverDir = fs.mkdtempSync(path.join(os.tmpdir(), "prism mcp 'probe' "));
  });

  afterEach(() => {
    fs.rmSync(serverDir, { recursive: true, force: true });
  });

  it("starts the server in its directory, whatever the CLI's own is", () => {
    const { probe } = entries([
      { kind: 'stdio', name: 'probe', command: 'pwd', args: [], env: {}, cwd: serverDir },
    ]);
    const out = execFileSync(probe.command ?? '', probe.args ?? [], { cwd: os.homedir() });
    expect(fs.realpathSync(out.toString('utf8').trim())).toBe(fs.realpathSync(serverDir));
  });

  it('hands the server its arguments unchanged', () => {
    const { probe } = entries([
      {
        kind: 'stdio',
        name: 'probe',
        command: 'printf',
        args: ['%s|', 'two words', '$HOME', '"q"'],
        env: {},
        cwd: serverDir,
      },
    ]);
    const out = execFileSync(probe.command ?? '', probe.args ?? []);
    expect(out.toString('utf8')).toBe('two words|$HOME|"q"|');
  });
});
