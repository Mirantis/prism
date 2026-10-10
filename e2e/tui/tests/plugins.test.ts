/**
 * Plugins slash command e2e for what the web suite does not assert: the
 * contribution lines `/plugins` prints for a healthy plugin, the diagnostics a
 * malformed plugin produces, and the agent's own call of a tool from a real
 * stdio MCP server. The web suite checks the plugin's name and version and runs
 * its skill (`e2e/features/web/plugins.feature`), and has the coding sub-agent
 * call its MCP tool; it installs no broken plugin.
 *
 * The runtime boots with PRISM_DATA_DIR pointed at a hermetic temp dir seeded
 * before boot with three plugins: a healthy one contributing a skill, one whose
 * mcp.json has an invalid server entry, and one targeting a spec version the
 * runtime does not implement. Between them they exercise the whole failure
 * ladder — the healthy plugin must keep working while the other two are skipped
 * or partially loaded with an attributable reason.
 *
 * Written with @amiceli/vitest-cucumber (features/plugins.feature).
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadFeatureFromText, describeFeature } from '@amiceli/vitest-cucumber';
import { startPrism, KEYS, type TuiSession } from '../harness';
import { setupRuntime, resetThread, type RuntimeTestEnv } from '../setup';

const feature = loadFeatureFromText(
  readFileSync(join(import.meta.dirname, '../features/plugins.feature'), 'utf8'),
);

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

let env: RuntimeTestEnv;
let session: TuiSession;
let dataDir: string;

/** Write one file inside a plugin directory, creating parents as needed. */
function writePluginFile(pluginsDir: string, id: string, rel: string, body: string): void {
  const path = join(pluginsDir, id, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

/**
 * Type a command line and submit it. The trailing space closes the slash popup,
 * so one Enter runs the command — the Enter-completes path is covered by
 * slash-commands.test.ts.
 */
async function dispatch(line: string): Promise<void> {
  session.send(line + ' ');
  await new Promise((r) => setTimeout(r, 300));
  session.send(KEYS.ENTER);
}

describeFeature(
  feature,
  ({ BeforeAllScenarios, AfterAllScenarios, BeforeEachScenario, AfterEachScenario, Scenario, defineSteps }) => {
    BeforeAllScenarios(async () => {
      // Hermetic data dir, seeded before the runtime boots so the plugins are in
      // the catalog from the first request.
      dataDir = mkdtempSync(join(tmpdir(), 'tui-e2e-plugins-'));
      const pluginsDir = join(dataDir, 'plugins');
      mkdirSync(pluginsDir, { recursive: true });

      // Healthy: contributes one skill, which `/plugins` must name. Nothing here
      // runs it — the web suite does — so its body only matches that fixture.
      writePluginFile(
        pluginsDir,
        'demo',
        'plugin.json',
        JSON.stringify({
          $schema: PLUGIN_SCHEMA,
          name: 'demo',
          version: '1.2.0',
          description: 'A demo plugin.',
        }),
      );
      writePluginFile(
        pluginsDir,
        'demo',
        'skills/plugin-marker/SKILL.md',
        '---\nname: plugin-marker\ndescription: Reply with a fixed plugin marker.\n---\n\n' +
          'When this skill is invoked, reply with exactly the following text and nothing else:\n\n' +
          'PLUGIN_SKILL_RAN_OK\n',
      );

      // A real MCP server, so the headline capability — spawn a stdio process,
      // qualify its tool name, have the agent call it — is exercised for real
      // rather than against the mocked SDK the unit tests use.
      //
      // Hand-rolled JSON-RPC rather than the MCP SDK: the fixture lives in a
      // temp dir with no `node_modules` above it, so an import would not
      // resolve. The protocol surface a client needs is three methods.
      writePluginFile(
        pluginsDir,
        'demo',
        'mcp.json',
        JSON.stringify({
          $schema: MCP_SCHEMA,
          mcpServers: {
            probe: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server.mjs'] },
          },
        }),
      );
      writePluginFile(
        pluginsDir,
        'demo',
        'server.mjs',
        [
          "let buffer = '';",
          "process.stdin.setEncoding('utf8');",
          "const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n');",
          'const handle = (msg) => {',
          "  if (msg.method === 'initialize') {",
          "    send({ jsonrpc: '2.0', id: msg.id, result: {",
          "      protocolVersion: msg.params?.protocolVersion ?? '2024-11-05',",
          '      capabilities: { tools: {} },',
          "      serverInfo: { name: 'e2e-probe', version: '1.0.0' },",
          '    } });',
          '    return;',
          '  }',
          "  if (msg.method === 'tools/list') {",
          "    send({ jsonrpc: '2.0', id: msg.id, result: { tools: [{",
          "      name: 'plugin_mcp_probe',",
          "      description: 'Returns a fixed marker proving the plugin MCP server ran.',",
          "      inputSchema: { type: 'object', properties: {} },",
          '    }] } });',
          '    return;',
          '  }',
          "  if (msg.method === 'tools/call') {",
          "    send({ jsonrpc: '2.0', id: msg.id, result: {",
          "      content: [{ type: 'text', text: 'PLUGIN_MCP_TOOL_OK' }],",
          '    } });',
          '    return;',
          '  }',
          '  // Notifications carry no id and want no reply.',
          '  if (msg.id !== undefined) {',
          "    send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } });",
          '  }',
          '};',
          "process.stdin.on('data', (chunk) => {",
          '  buffer += chunk;',
          '  let at;',
          "  while ((at = buffer.indexOf('\\n')) !== -1) {",
          '    const line = buffer.slice(0, at).trim();',
          '    buffer = buffer.slice(at + 1);',
          '    if (line) handle(JSON.parse(line));',
          '  }',
          '});',
          '',
        ].join('\n'),
      );

      // Valid manifest, invalid MCP server entry: the plugin still loads and the
      // reason is reported, rather than the whole plugin disappearing.
      writePluginFile(
        pluginsDir,
        'half-broken',
        'plugin.json',
        JSON.stringify({ $schema: PLUGIN_SCHEMA, name: 'half-broken' }),
      );
      writePluginFile(
        pluginsDir,
        'half-broken',
        'mcp.json',
        JSON.stringify({
          $schema: MCP_SCHEMA,
          mcpServers: { broken: { type: 'stdio', command: 'npx -y something' } },
        }),
      );

      // Targets a spec version this runtime does not implement — skipped whole.
      writePluginFile(
        pluginsDir,
        'bad-version',
        'plugin.json',
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/2.0.0/plugin.schema.json',
          name: 'bad-version',
        }),
      );

      env = await setupRuntime({ runtimeEnvOverrides: { PRISM_DATA_DIR: dataDir } });
    });
    AfterAllScenarios(async () => {
      await env.cleanup();
      rmSync(dataDir, { recursive: true, force: true });
    });
    BeforeEachScenario(async () => {
      resetThread(env.dbPath);
      session = startPrism({ env: env.prismEnv, runtime: env.runtime });
      await session.waitForFrame(/Prism/, 30_000);
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
      Step('I do not see {string}', async (_ctx, text: string) => {
        // The listing has already rendered by the time this runs (the preceding
        // "I see" awaited it), so the output is settled and this is a real check.
        await new Promise((r) => setTimeout(r, 500));
        if (session.output().includes(text)) {
          throw new Error(`expected the output not to contain ${JSON.stringify(text)}`);
        }
      });
    });

    Scenario('/plugins reports what the plugin contributes', () => {
      // Covered by the shared steps.
    });
    Scenario('/plugins reports a plugin that failed to load its MCP servers', () => {
      // Covered by the shared steps.
    });
    Scenario('a broken plugin does not stop a healthy one', () => {
      // Covered by the shared steps.
    });
    Scenario('the agent can call a tool from a plugin\'s stdio MCP server', () => {
      // Covered by the shared steps.
    });
  },
);
