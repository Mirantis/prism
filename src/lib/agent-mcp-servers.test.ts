/**
 * The MCP servers a coding task gets: the platform endpoint when one is
 * configured, every plugin server under its plugin's name, and a plugin's stdio
 * server only where the plugin's files are.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { config } from '../config';
import { pluginMcpService } from '../services/plugin-mcp.service';
import type { ResolvedServer } from '../services/plugin-mcp-config';
import { fakeExecutionEnvironment } from '../test-utils/fake-execution-environment';
import { agentMcpServers } from './agent-mcp-servers';
import { __setExecutionEnvironmentForTests } from './execution-environments/get-execution-environment';

const STDIO: ResolvedServer = {
  kind: 'stdio',
  name: 'probe',
  command: 'node',
  args: [],
  env: {},
  cwd: '/prism/plugins/demo',
};
const REMOTE: ResolvedServer = {
  kind: 'http',
  name: 'remote',
  url: 'https://remote.example.test/mcp',
  headers: {},
};

let savedUrl: string | null;

beforeEach(() => {
  savedUrl = config.nexusMcpUrl;
  config.nexusMcpUrl = null;
  vi.spyOn(pluginMcpService, 'configuredServers').mockReturnValue([
    { pluginId: 'demo', server: REMOTE },
    { pluginId: 'demo', server: STDIO },
  ]);
});

afterEach(() => {
  config.nexusMcpUrl = savedUrl;
  __setExecutionEnvironmentForTests(null);
  vi.restoreAllMocks();
});

describe('agentMcpServers', () => {
  it('names each plugin server after its plugin, the prefix of its tools in the agent', () => {
    expect(agentMcpServers().map((s) => s.name)).toEqual(['demo__remote', 'demo__probe']);
  });

  it('puts the platform endpoint first when one is configured, with no credential', () => {
    config.nexusMcpUrl = 'https://gateway.example.test/projects/p/mcp';
    expect(agentMcpServers()[0]).toEqual({
      kind: 'http',
      name: 'nexus',
      url: 'https://gateway.example.test/projects/p/mcp',
      headers: {},
    });
  });

  it('keeps both servers when two plugin ids sanitize to one name', () => {
    vi.mocked(pluginMcpService.configuredServers).mockReturnValue([
      { pluginId: 'foo.bar', server: REMOTE },
      { pluginId: 'foo_bar', server: REMOTE },
    ]);
    const names = agentMcpServers().map((s) => s.name);
    expect(names[0]).toBe('foo_bar__remote');
    expect(names[1]).toMatch(/^foo_bar__remote_[0-9a-f]{7}$/);
    // The same on every call, so a resumed task sees the same names.
    expect(agentMcpServers().map((s) => s.name)).toEqual(names);
  });

  it('is empty with no endpoint and no plugin server', () => {
    vi.mocked(pluginMcpService.configuredServers).mockReturnValue([]);
    expect(agentMcpServers()).toEqual([]);
  });

  describe('when the agent runs its commands in a container', () => {
    beforeEach(() => {
      __setExecutionEnvironmentForTests(
        fakeExecutionEnvironment({ servesPath: (p) => p.startsWith('/prism/') }),
      );
    });

    it('keeps the stdio server for a task inside the container', () => {
      expect(agentMcpServers('/prism/workspace').map((s) => s.name)).toEqual([
        'demo__remote',
        'demo__probe',
      ]);
    });

    it('leaves the stdio server out for a task rooted on the host, where its files are not', () => {
      expect(agentMcpServers('/Users/me/repo').map((s) => s.name)).toEqual(['demo__remote']);
    });
  });
});
