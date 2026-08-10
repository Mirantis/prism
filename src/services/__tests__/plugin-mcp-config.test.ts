/**
 * Agent Plugins mcp.json Tests
 *
 * Table-driven coverage of the MCP configuration rules in Agent Plugins 1.0.0 —
 * the closed schemas, the single-token command rule, reserved environment
 * names, single-pass placeholder expansion, and path containment. Pure: nothing
 * here connects to or spawns anything.
 */

import { describe, it, expect } from 'vitest';
import path from 'path';
import { parseMcpJson, MCP_SCHEMA_1_0_0, type ParseResult } from '../plugin-mcp-config';

const PLUGIN_ROOT = path.resolve('/tmp/prism-plugins/demo');
const PLUGIN_DATA = path.resolve('/tmp/prism-plugin-data/demo');
const ctx = { pluginId: 'demo', pluginRoot: PLUGIN_ROOT, pluginData: PLUGIN_DATA };

/** Build an mcp.json document around the given server map. */
function doc(servers: Record<string, unknown>, schema: string = MCP_SCHEMA_1_0_0): string {
  return JSON.stringify({ $schema: schema, mcpServers: servers });
}

/** Parse, asserting the file itself was usable. */
function parse(raw: string): ParseResult {
  const result = parseMcpJson(raw, ctx);
  expect(result).not.toBeNull();
  return result as ParseResult;
}

describe('parseMcpJson — file-level validity', () => {
  it('accepts a well-formed document', () => {
    const result = parse(doc({ probe: { type: 'stdio', command: 'node' } }));
    expect(result.servers).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });

  it.each([
    ['unparseable JSON', '{ not json'],
    ['a JSON array', '[]'],
    [
      'an unsupported $schema version',
      JSON.stringify({
        $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
        mcpServers: {},
      }),
    ],
    ['an unknown top-level field', JSON.stringify({ $schema: MCP_SCHEMA_1_0_0, mcpServers: {}, extra: 1 })],
    ['a non-object mcpServers', JSON.stringify({ $schema: MCP_SCHEMA_1_0_0, mcpServers: [] })],
  ])('disables MCP for the plugin on %s', (_label, raw) => {
    expect(parseMcpJson(raw, ctx)).toBeNull();
  });

  it('accepts a file with no $schema, which is what people actually write', () => {
    // Every mcp.json in the wild — Claude Code, Cursor, VS Code — omits it.
    // Rejecting the file would load zero servers while the plugin's skills kept
    // working, which reads as a runtime bug rather than a malformed file.
    const raw = JSON.stringify({
      mcpServers: { probe: { command: 'npx', args: ['-y', 'server'] } },
    });
    const result = parseMcpJson(raw, ctx);
    expect(result).not.toBeNull();
    expect(result?.servers.map((s) => s.name)).toEqual(['probe']);
    expect(result?.warnings.join()).toContain('no "$schema"');
  });

  it('still rejects a $schema that names a version we do not implement', () => {
    // Absent means "unstated"; present-and-different is a real declaration.
    const raw = JSON.stringify({
      $schema: 'https://agent-plugins.org/schemas/2.0.0/mcp.schema.json',
      mcpServers: { probe: { type: 'stdio', command: 'node' } },
    });
    expect(parseMcpJson(raw, ctx)).toBeNull();
  });

  it('returns servers in name order regardless of how the JSON was written', () => {
    const result = parse(
      doc({
        zeta: { type: 'stdio', command: 'node' },
        alpha: { type: 'stdio', command: 'node' },
      }),
    );
    expect(result.servers.map((s) => s.name)).toEqual(['alpha', 'zeta']);
  });

  it('skips one bad entry while its siblings still load', () => {
    const result = parse(
      doc({
        good: { type: 'stdio', command: 'node' },
        bad: { type: 'nonsense' },
      }),
    );
    expect(result.servers.map((s) => s.name)).toEqual(['good']);
    expect(result.warnings.join()).toContain('unsupported transport type');
  });
});

describe('parseMcpJson — stdio', () => {
  it('resolves command, args, env and cwd', () => {
    const result = parse(
      doc({
        probe: {
          type: 'stdio',
          command: 'node',
          args: ['server.js'],
          env: { MODE: 'live' },
          cwd: './work',
        },
      }),
    );
    expect(result.servers[0]).toMatchObject({
      kind: 'stdio',
      name: 'probe',
      command: 'node',
      args: ['server.js'],
      cwd: path.join(PLUGIN_ROOT, 'work'),
    });
  });

  it('defaults cwd to the plugin root', () => {
    const result = parse(doc({ probe: { type: 'stdio', command: 'node' } }));
    expect(result.servers[0]).toMatchObject({ cwd: PLUGIN_ROOT });
  });

  it('assumes stdio when type is omitted, and says so', () => {
    const result = parse(doc({ probe: { command: 'node' } }));
    expect(result.servers[0].kind).toBe('stdio');
    expect(result.warnings.join()).toContain('assuming "stdio"');
  });

  it('always supplies PLUGIN_ROOT and PLUGIN_DATA to the subprocess', () => {
    const result = parse(doc({ probe: { type: 'stdio', command: 'node' } }));
    const server = result.servers[0];
    if (server.kind !== 'stdio') throw new Error('expected a stdio server');
    expect(server.env).toMatchObject({ PLUGIN_ROOT, PLUGIN_DATA });
  });

  it('rejects a server that tries to define the reserved variables itself', () => {
    const result = parse(
      doc({ probe: { type: 'stdio', command: 'node', env: { PLUGIN_ROOT: '/elsewhere' } } }),
    );
    expect(result.servers).toEqual([]);
    expect(result.warnings.join()).toContain('must not define PLUGIN_ROOT');
  });

  it.each([
    ['npx -y foo', 'a whitespace-separated command'],
    ['sh; rm -rf /', 'shell metacharacters'],
    ['/usr/bin/node', 'an absolute path'],
    ['../escape', 'a relative path outside the plugin'],
  ])('rejects the command %j (%s)', (command) => {
    const result = parse(doc({ probe: { type: 'stdio', command } }));
    expect(result.servers).toEqual([]);
  });

  it('resolves a ./-relative command against the plugin root', () => {
    const result = parse(doc({ probe: { type: 'stdio', command: './bin/server' } }));
    expect(result.servers[0]).toMatchObject({ command: path.join(PLUGIN_ROOT, 'bin', 'server') });
  });

  it('rejects unknown stdio fields, naming them so the author can act', () => {
    const result = parse(
      doc({ probe: { type: 'stdio', command: 'node', disabled: true, description: 'x' } }),
    );
    expect(result.servers).toEqual([]);
    // Naming the fields is the point: "contains unknown fields" says the server
    // was skipped but not what to delete.
    expect(result.warnings.join()).toContain('description, disabled');
    expect(result.warnings.join()).toContain('allowed: type, command, args, env, cwd');
  });

  it.each([['${PLUGIN_ROOT}/../..'], ['./../..'], ['/etc'], ['${HOME}']])(
    'rejects the cwd %j',
    (cwd) => {
      const result = parse(doc({ probe: { type: 'stdio', command: 'node', cwd } }));
      expect(result.servers).toEqual([]);
    },
  );

  it('anchors a ${PLUGIN_DATA} cwd to the data dir', () => {
    const result = parse(
      doc({ probe: { type: 'stdio', command: 'node', cwd: '${PLUGIN_DATA}/cache' } }),
    );
    expect(result.servers[0]).toMatchObject({ cwd: path.join(PLUGIN_DATA, 'cache') });
  });
});

describe('parseMcpJson — placeholder expansion', () => {
  it('expands in args, env values and cwd', () => {
    const result = parse(
      doc({
        probe: {
          type: 'stdio',
          command: 'node',
          args: ['${PLUGIN_ROOT}/server.js', '--state=${PLUGIN_DATA}'],
          env: { CONFIG: '${PLUGIN_ROOT}/config.json' },
          cwd: '${PLUGIN_DATA}',
        },
      }),
    );
    const server = result.servers[0];
    if (server.kind !== 'stdio') throw new Error('expected a stdio server');
    expect(server.args).toEqual([`${PLUGIN_ROOT}/server.js`, `--state=${PLUGIN_DATA}`]);
    expect(server.env.CONFIG).toBe(`${PLUGIN_ROOT}/config.json`);
    expect(server.cwd).toBe(PLUGIN_DATA);
  });

  it('never expands inside command — a placeholder there is rejected outright', () => {
    // The spec forbids expanding `command`. Rejecting is stricter than passing
    // it through unexpanded, and it is the case a laxer token rule gets wrong:
    // ${PLUGIN_ROOT} has no slash or whitespace, so a naive bare-name check
    // accepts it and the expansion then silently rewrites the executable.
    const result = parse(doc({ probe: { type: 'stdio', command: '${PLUGIN_ROOT}/bin/server' } }));
    expect(result.servers).toEqual([]);
    expect(result.warnings.join()).toContain('single token');
  });

  it('does not expand env keys', () => {
    const result = parse(
      doc({ probe: { type: 'stdio', command: 'node', env: { '${PLUGIN_ROOT}': 'x' } } }),
    );
    const server = result.servers[0];
    if (server.kind !== 'stdio') throw new Error('expected a stdio server');
    expect(server.env).toHaveProperty('${PLUGIN_ROOT}', 'x');
  });

  it('is a single pass — replacement text is not rescanned', () => {
    // Substituting a value that itself reads as a placeholder must not expand again.
    const nested = { pluginId: 'demo', pluginRoot: '${PLUGIN_DATA}', pluginData: PLUGIN_DATA };
    const result = parseMcpJson(
      doc({ probe: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}'] } }),
      nested,
    );
    expect(result?.servers[0]).toMatchObject({ args: ['${PLUGIN_DATA}'] });
  });

  it('leaves an unrecognized placeholder literal', () => {
    const result = parse(
      doc({ probe: { type: 'stdio', command: 'node', args: ['${SOMETHING_ELSE}'] } }),
    );
    expect(result.servers[0]).toMatchObject({ args: ['${SOMETHING_ELSE}'] });
  });
});

describe('parseMcpJson — remote transports', () => {
  it('maps the spec name streamable-http onto the SDK name http', () => {
    const result = parse(doc({ api: { type: 'streamable-http', url: 'https://x.dev/mcp' } }));
    expect(result.servers[0]).toMatchObject({ kind: 'http', url: 'https://x.dev/mcp' });
  });

  it('rejects the SDK name http in the file format', () => {
    const result = parse(doc({ api: { type: 'http', url: 'https://x.dev/mcp' } }));
    expect(result.servers).toEqual([]);
  });

  it('accepts legacy sse', () => {
    const result = parse(doc({ api: { type: 'sse', url: 'https://x.dev/sse' } }));
    expect(result.servers[0]).toMatchObject({ kind: 'sse' });
  });

  it.each([
    ['not-a-url'],
    ['ftp://x.dev/mcp'],
    ['http://x.dev/mcp'],
    ['https://user:pw@x.dev/mcp'],
    ['https://x.dev/mcp#frag'],
  ])('rejects the url %j', (url) => {
    const result = parse(doc({ api: { type: 'streamable-http', url } }));
    expect(result.servers).toEqual([]);
  });

  it('allows plain http on loopback', () => {
    const result = parse(doc({ api: { type: 'streamable-http', url: 'http://localhost:8080/mcp' } }));
    expect(result.servers).toHaveLength(1);
  });

  it('keeps ordinary headers and drops the ones the runtime owns', () => {
    const result = parse(
      doc({
        api: {
          type: 'streamable-http',
          url: 'https://x.dev/mcp',
          headers: { 'X-Tenant': 'acme', Authorization: 'Bearer leaked' },
        },
      }),
    );
    const server = result.servers[0];
    if (server.kind === 'stdio') throw new Error('expected a remote server');
    expect(server.headers).toEqual({ 'X-Tenant': 'acme' });
    expect(result.warnings.join()).toContain('the runtime owns it');
  });

  it('rejects unknown remote fields', () => {
    const result = parse(
      doc({ api: { type: 'streamable-http', url: 'https://x.dev/mcp', command: 'node' } }),
    );
    expect(result.servers).toEqual([]);
  });
});

describe('parseMcpJson — server names', () => {
  it.each([['has space'], ['-leading'], ['dots.not.allowed'], ['']])(
    'rejects the server name %j',
    (name) => {
      const result = parse(doc({ [name]: { type: 'stdio', command: 'node' } }));
      expect(result.servers).toEqual([]);
    },
  );
});
