/**
 * Plugin MCP Service Tests
 *
 * Both SDK entry points are mocked, so no process is ever spawned and no socket
 * opened. The transport constructor argument is captured, which makes it the
 * assertion surface for everything that matters at launch time: the resolved
 * command, the expanded args, the injected PLUGIN_ROOT/PLUGIN_DATA, and cwd.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockCreateMCPClient, MockExecTransport, transportArgs } = vi.hoisted(() => {
  const transportArgs: Record<string, unknown>[] = [];
  // The second argument is what the service resolved for this server; the
  // first is the execution environment the server will run in.
  class MockExecTransport {
    constructor(_environment: unknown, config: Record<string, unknown>) {
      transportArgs.push(config);
    }
  }
  return { mockCreateMCPClient: vi.fn(), MockExecTransport, transportArgs };
});

vi.mock('@ai-sdk/mcp', () => ({ experimental_createMCPClient: mockCreateMCPClient }));
vi.mock('../../lib/execution-environments/exec-stdio-transport', () => ({
  ExecStdioTransport: MockExecTransport,
}));

import { pluginMcpService, __test } from '../plugin-mcp.service';
import { pluginCatalogService, PLUGIN_SCHEMA_1_0_0 } from '../plugin-catalog.service';
import { MCP_SCHEMA_1_0_0 } from '../plugin-mcp-config';

let tmp: string;
let pluginsDir: string;
let savedDataDir: string | undefined;
let savedPluginsDir: string | undefined;
let closeSpy: ReturnType<typeof vi.fn>;

/** Install a plugin whose mcp.json declares the given servers. */
function writePlugin(id: string, servers: Record<string, unknown>): string {
  const dir = path.join(pluginsDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'plugin.json'),
    JSON.stringify({ $schema: PLUGIN_SCHEMA_1_0_0, name: id }),
  );
  fs.writeFileSync(
    path.join(dir, 'mcp.json'),
    JSON.stringify({ $schema: MCP_SCHEMA_1_0_0, mcpServers: servers }),
  );
  return dir;
}

/** Make the next connect resolve with a client exposing the given tool names. */
function serveTools(...names: string[]): void {
  mockCreateMCPClient.mockResolvedValue({
    tools: vi.fn().mockResolvedValue(Object.fromEntries(names.map((n) => [n, { description: n }]))),
    close: closeSpy,
  });
}

beforeEach(() => {
  savedDataDir = process.env.PRISM_DATA_DIR;
  savedPluginsDir = process.env.PRISM_PLUGINS_DIR;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prism-plugin-mcp-test-'));
  pluginsDir = path.join(tmp, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  process.env.PRISM_DATA_DIR = tmp;
  process.env.PRISM_PLUGINS_DIR = pluginsDir;

  // `mockReset: true` wipes implementations before each test, and the hoisted
  // array is module-scoped, so both need re-arming here.
  transportArgs.length = 0;
  closeSpy = vi.fn().mockResolvedValue(undefined);
  serveTools('search');

  pluginCatalogService.invalidate();
  pluginMcpService.reset();
});

afterEach(() => {
  if (savedDataDir === undefined) delete process.env.PRISM_DATA_DIR;
  else process.env.PRISM_DATA_DIR = savedDataDir;
  if (savedPluginsDir === undefined) delete process.env.PRISM_PLUGINS_DIR;
  else process.env.PRISM_PLUGINS_DIR = savedPluginsDir;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('PluginMcpService.getTools', () => {
  it('returns nothing when no plugin declares MCP servers', async () => {
    expect(await pluginMcpService.getTools()).toEqual({});
    expect(mockCreateMCPClient).not.toHaveBeenCalled();
  });

  it('connects a stdio server and qualifies its tools', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node', args: ['server.js'] } });
    pluginCatalogService.invalidate();

    const tools = await pluginMcpService.getTools();
    expect(Object.keys(tools)).toEqual(['demo__probe__search']);
  });

  it('launches with the resolved command, cwd and injected plugin variables', async () => {
    const dir = writePlugin('demo', {
      probe: {
        type: 'stdio',
        command: 'node',
        args: ['${PLUGIN_ROOT}/server.js'],
        env: { MODE: 'live' },
      },
    });
    pluginCatalogService.invalidate();
    await pluginMcpService.getTools();

    expect(transportArgs).toHaveLength(1);
    expect(transportArgs[0]).toMatchObject({
      command: 'node',
      args: [path.join(dir, 'server.js')],
      cwd: dir,
      env: {
        MODE: 'live',
        PLUGIN_ROOT: dir,
        PLUGIN_DATA: path.join(tmp, 'plugin-data', 'demo'),
      },
    });
  });

  it('creates the plugin data dir before launching a stdio server', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    await pluginMcpService.getTools();

    expect(fs.statSync(path.join(tmp, 'plugin-data', 'demo')).isDirectory()).toBe(true);
  });

  it('passes a remote server through as a transport config, not a stdio process', async () => {
    writePlugin('demo', {
      api: { type: 'streamable-http', url: 'https://x.dev/mcp', headers: { 'X-Tenant': 'acme' } },
    });
    pluginCatalogService.invalidate();
    await pluginMcpService.getTools();

    expect(transportArgs).toHaveLength(0);
    expect(mockCreateMCPClient).toHaveBeenCalledWith(
      expect.objectContaining({
        transport: { type: 'http', url: 'https://x.dev/mcp', headers: { 'X-Tenant': 'acme' } },
      }),
    );
  });

  it('calls tools() once per connection, not once per turn', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();

    await pluginMcpService.getTools();
    await pluginMcpService.getTools();
    await pluginMcpService.getTools();

    // One connect, and therefore one child process, across three turns.
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent refreshes into a single connect', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();

    // Chat and compaction can both be inside collectTools() at the same time.
    await Promise.all([pluginMcpService.getTools(), pluginMcpService.getTools()]);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it('keeps working when a server fails to start', async () => {
    writePlugin('broken', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    mockCreateMCPClient.mockRejectedValue(new Error('boom'));

    expect(await pluginMcpService.getTools()).toEqual({});
  });

  it('reports why a server failed, so the API can attribute it', async () => {
    writePlugin('broken', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    mockCreateMCPClient.mockRejectedValue(new Error('Connection closed'));

    await pluginMcpService.getTools();

    expect(pluginMcpService.getServerStatuses()).toEqual([
      { pluginId: 'broken', serverName: 'probe', status: 'failed', error: 'Connection closed' },
    ]);
  });

  it('reports a connected server as ready', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();

    await pluginMcpService.getTools();

    expect(pluginMcpService.getServerStatuses()).toEqual([
      { pluginId: 'demo', serverName: 'probe', status: 'ready' },
    ]);
  });

  it('closes the client when the tools() handshake fails', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    mockCreateMCPClient.mockResolvedValue({
      tools: vi.fn().mockRejectedValue(new Error('no tools capability')),
      close: closeSpy,
    });

    expect(await pluginMcpService.getTools()).toEqual({});

    // The client connected before the handshake failed — without an explicit
    // close it stays unreferenced with a live child process behind it.
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(pluginMcpService.getServerStatuses()).toEqual([
      { pluginId: 'demo', serverName: 'probe', status: 'failed', error: 'no tools capability' },
    ]);
  });

  it('closes a client whose connect only finishes after the timeout', async () => {
    writePlugin('slow', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();

    // Only the timers, so `setImmediate` below still turns the event loop.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let resolveCreate!: (client: unknown) => void;
      mockCreateMCPClient.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));

      const pending = pluginMcpService.getTools();
      // The catalog scan reads the disk before the connect timeout is armed,
      // and a fake clock does not drive a read. Wait for that timer to exist,
      // or the advance below lands before there is anything to fire.
      while (vi.getTimerCount() === 0) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual({});

      // The connect settles late — the child process was already spawned before
      // the race was lost, so it must be closed, not leaked.
      resolveCreate({ tools: vi.fn().mockResolvedValue({}), close: closeSpy });
      await vi.advanceTimersByTimeAsync(0);
      expect(closeSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed server once its backoff has elapsed', async () => {
    // A cold `npx -y <server>` download can lose the first race and win the
    // next. Without a retry the server is dead for the container's lifetime.
    vi.useFakeTimers();
    try {
      writePlugin('slow', { probe: { type: 'stdio', command: 'node' } });
      pluginCatalogService.invalidate();
      mockCreateMCPClient.mockRejectedValue(new Error('timed out after 10000ms'));

      expect(await pluginMcpService.getTools()).toEqual({});
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);

      // The package has finished installing by the time the backoff expires.
      serveTools('search');
      vi.advanceTimersByTime(30_000);

      expect(Object.keys(await pluginMcpService.getTools())).toEqual(['slow__probe__search']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('widens the interval between attempts rather than retrying every turn', async () => {
    vi.useFakeTimers();
    try {
      writePlugin('dead', { probe: { type: 'stdio', command: 'node' } });
      pluginCatalogService.invalidate();
      mockCreateMCPClient.mockRejectedValue(new Error('boom'));

      await pluginMcpService.getTools();
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);

      // Second attempt after 30s, and the wait then doubles: 30s later is not
      // yet due, 60s later is.
      vi.advanceTimersByTime(30_000);
      await pluginMcpService.getTools();
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(30_000);
      await pluginMcpService.getTools();
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(30_000);
      await pluginMcpService.getTools();
      expect(mockCreateMCPClient).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not respawn a failed server on the very next turn', async () => {
    // The backoff has not elapsed, so consecutive turns cost nothing.
    writePlugin('broken', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    mockCreateMCPClient.mockRejectedValue(new Error('boom'));

    await pluginMcpService.getTools();
    await pluginMcpService.getTools();
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(1);
  });

  it('loads a valid plugin even when another plugin has an unusable mcp.json', async () => {
    writePlugin('good', { probe: { type: 'stdio', command: 'node' } });
    const badDir = path.join(pluginsDir, 'bad');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(
      path.join(badDir, 'plugin.json'),
      JSON.stringify({ $schema: PLUGIN_SCHEMA_1_0_0, name: 'bad' }),
    );
    fs.writeFileSync(path.join(badDir, 'mcp.json'), '{ not json');
    pluginCatalogService.invalidate();

    expect(Object.keys(await pluginMcpService.getTools())).toEqual(['good__probe__search']);
  });

  it('keeps refreshing other plugins when one mcp.json can no longer be stat-ed', async () => {
    // The catalog is mtime-cached on the plugins dir, so mcp.json can turn
    // unreadable after the scan that recorded its path — replaced by a
    // self-referential symlink here, which makes stat throw ELOOP rather than
    // return undefined. That must skip this plugin's servers only, not abort
    // the whole refresh.
    writePlugin('good', { probe: { type: 'stdio', command: 'node' } });
    const trickyDir = writePlugin('tricky', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    // Record both mcp.json paths in the catalog, then break tricky's without
    // touching the plugins dir (so the catalog keeps the recorded path).
    expect(await pluginCatalogService.getPlugins()).toHaveLength(2);
    fs.rmSync(path.join(trickyDir, 'mcp.json'));
    fs.symlinkSync('mcp.json', path.join(trickyDir, 'mcp.json'));

    expect(Object.keys(await pluginMcpService.getTools())).toEqual(['good__probe__search']);
  });

  it('drops a plugin removed from disk and closes its client', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    expect(Object.keys(await pluginMcpService.getTools())).toHaveLength(1);

    fs.rmSync(path.join(pluginsDir, 'demo'), { recursive: true, force: true });
    pluginCatalogService.invalidate();

    expect(await pluginMcpService.getTools()).toEqual({});
    expect(closeSpy).toHaveBeenCalled();
  });

  it('orders tools deterministically across plugins and servers', async () => {
    writePlugin('zeta', { srv: { type: 'stdio', command: 'node' } });
    writePlugin('alpha', { srv: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    serveTools('beta', 'alpha');

    const keys = Object.keys(await pluginMcpService.getTools());
    expect(keys).toEqual([
      'alpha__srv__alpha',
      'alpha__srv__beta',
      'zeta__srv__alpha',
      'zeta__srv__beta',
    ]);
  });
});

describe('PluginMcpService server crash handling', () => {
  /** The onUncaughtError callback the service handed to the SDK. */
  function crashHandler(): (error: unknown) => void {
    const config = mockCreateMCPClient.mock.calls[0][0] as {
      onUncaughtError: (error: unknown) => void;
    };
    return config.onUncaughtError;
  }

  it('closes the client when a connected server errors', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    await pluginMcpService.getTools();

    crashHandler()(new Error('Connection closed'));

    // Without this the child process is orphaned: the entry is gone, so
    // shutdownAll() would never close it either.
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it('withdraws the dead server tools even when its plugin is gone', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    expect(Object.keys(await pluginMcpService.getTools())).toHaveLength(1);

    // Server dies, then the plugin is uninstalled. The key is now in neither
    // the entry map nor the next refresh's desired set, so nothing downstream
    // would notice the tools were stale.
    crashHandler()(new Error('Connection closed'));
    fs.rmSync(path.join(pluginsDir, 'demo'), { recursive: true, force: true });
    pluginCatalogService.invalidate();

    expect(await pluginMcpService.getTools()).toEqual({});
  });

  it('reconnects on the next turn when the plugin is still installed', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    await pluginMcpService.getTools();

    crashHandler()(new Error('Connection closed'));

    expect(Object.keys(await pluginMcpService.getTools())).toEqual(['demo__probe__search']);
    expect(mockCreateMCPClient).toHaveBeenCalledTimes(2);
  });
});

describe('PluginMcpService.shutdownAll', () => {
  it('closes live clients and empties the tool set', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();
    await pluginMcpService.getTools();

    await pluginMcpService.shutdownAll();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(pluginMcpService.getServerStatuses()).toEqual([]);
    expect(await pluginMcpService.getTools()).toEqual({});
  });

  it('is safe to call with nothing connected', async () => {
    await expect(pluginMcpService.shutdownAll()).resolves.toBeUndefined();
  });

  it('does not resurrect a connection that completes after shutdown', async () => {
    writePlugin('demo', { probe: { type: 'stdio', command: 'node' } });
    pluginCatalogService.invalidate();

    let resolveCreate!: (client: unknown) => void;
    mockCreateMCPClient.mockReturnValue(new Promise((resolve) => { resolveCreate = resolve; }));

    const pending = pluginMcpService.getTools();
    await pluginMcpService.shutdownAll();

    // The in-flight connect wins its race only now, after the map was cleared.
    resolveCreate({ tools: vi.fn().mockResolvedValue({ search: {} }), close: closeSpy });
    expect(await pending).toEqual({});
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(pluginMcpService.getServerStatuses()).toEqual([]);
  });
});

describe('qualifyToolName', () => {
  it('joins the three segments with a double underscore', () => {
    expect(__test.qualifyToolName('demo', 'probe', 'search')).toBe('demo__probe__search');
  });

  it('replaces characters outside the provider charset', () => {
    expect(__test.qualifyToolName('my.plugin', 'srv', 'read:file')).toBe(
      'my_plugin__srv__read_file',
    );
  });

  it('prefixes a name that would otherwise start with a digit', () => {
    // An integer-like key is enumerated first whatever the insertion order,
    // which would break the ordering the prompt cache depends on.
    expect(__test.qualifyToolName('12306', 'srv', 'search')).toBe('t_12306__srv__search');
  });

  it('keeps a namespace for a segment that sanitizes to nothing', () => {
    // Directory names are not held to the spec's manifest-name pattern, so a
    // plugin folder called "___" is reachable. Dropping the empty segment would
    // strip its namespace and let two such plugins collide on one tool name.
    const a = __test.qualifyToolName('___', 'srv', 'search');
    const b = __test.qualifyToolName('...', 'srv', 'search');
    expect(a).not.toBe(b);
    expect(a.endsWith('__srv__search')).toBe(true);
    expect(a).not.toBe('srv__search');
    // Stable across calls, so the tools block survives a restart unchanged.
    expect(__test.qualifyToolName('___', 'srv', 'search')).toBe(a);
  });

  it('caps at 64 characters — the Bedrock Converse limit, not the Anthropic one', () => {
    const name = __test.qualifyToolName('a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40));
    expect(name.length).toBe(64);
  });

  it('keeps two over-long names distinct and stable', () => {
    const long = 'x'.repeat(80);
    const a = __test.qualifyToolName('plugin', 'server', `${long}_one`);
    const b = __test.qualifyToolName('plugin', 'server', `${long}_two`);
    expect(a).not.toBe(b);
    // Stable across calls, so the tools block survives a restart unchanged.
    expect(__test.qualifyToolName('plugin', 'server', `${long}_one`)).toBe(a);
  });
});
