/**
 * Plugin MCP Service
 *
 * Owns the MCP servers contributed by installed Agent Plugins: connecting them,
 * naming their tools, and closing them at shutdown.
 *
 * The load-bearing decision is that `client.tools()` is called **once, at
 * connect time**, and the resulting tool map is cached. Three things fall out of
 * that:
 *
 *   - one child process per server rather than one per turn (the tool objects
 *     close over a live connection, so a per-turn client would leak a process);
 *   - a tools block that is byte-identical across turns and across the chat and
 *     compaction paths by construction, which is what keeps the provider's
 *     prompt cache warm;
 *   - no `tools/list` round-trip on the hot path.
 *
 * The trade is that a server which changes its tool list while running is not
 * noticed until it reconnects. For a cache-sensitive tools block that is the
 * behaviour we want.
 *
 * Connection is lazy — the first turn that collects tools pays for it — and
 * steady state costs one `stat` per plugin. Dropping a plugin in is picked up on
 * the next turn without a restart, matching how skills behave.
 */

import fs from 'fs';
import type { Tool } from 'ai';
import { experimental_createMCPClient } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { logger } from '../logger';
import { resolvePluginDataDir } from '../lib/data-dir';
import { sanitizeToolNameSegment, toModelToolName } from '../lib/tool-names';
import { pluginCatalogService } from './plugin-catalog.service';
import { parseMcpJson, type ResolvedServer } from './plugin-mcp-config';

type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>;

/** How long a single server gets to connect before we give up on it. */
const CONNECT_TIMEOUT_MS = 10_000;

/** Bounded so shutdown stays well inside the process-level force-exit budget. */
const SHUTDOWN_TIMEOUT_MS = 2_000;

/**
 * Backoff for a server that failed to start.
 *
 * A failure is not evidence the server is broken. The shape the docs recommend
 * — `npx -y <server>` — downloads its package on first run, and a cold download
 * routinely overruns the connect timeout. Without a retry that server stays dead
 * for the life of the container, which is one per agent and long-lived, even
 * though the download finished seconds later. Same for a remote host that was
 * briefly unreachable on the first turn.
 *
 * Doubling from 30s and capped at 15 minutes: quick enough that a cold install
 * recovers on the next turn or two, slow enough that a genuinely dead server is
 * not respawned on every turn forever.
 */
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;

function retryDelayMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS);
}

interface DesiredServer {
  pluginId: string;
  server: ResolvedServer;
  /** Identifies the plugin's mcp.json contents; a change forces a reconnect. */
  fingerprint: string;
}

type Entry =
  | { status: 'ready'; fingerprint: string; client: MCPClient; tools: Record<string, Tool> }
  | {
      status: 'failed';
      fingerprint: string;
      error: string;
      /** Consecutive failures for this config; drives the backoff. */
      attempts: number;
      /** Epoch ms before which no retry is made. */
      nextRetryAt: number;
    };

/** One server's outcome, for the management API to attribute a failure. */
export interface ServerStatus {
  pluginId: string;
  serverName: string;
  status: 'ready' | 'failed';
  /** Why it failed — present only when `status` is `'failed'`. */
  error?: string;
}

interface CachedConfig {
  fingerprint: string;
  servers: ResolvedServer[];
}

class PluginMcpService {
  /** Keyed `${pluginId}/${serverName}`. */
  private entries = new Map<string, Entry>();
  /** Parsed mcp.json per plugin id, so a steady-state refresh does no reads. */
  private configs = new Map<string, CachedConfig>();
  private merged: Record<string, Tool> = {};
  private inflight: Promise<Record<string, Tool>> | null = null;
  /** Set by shutdownAll(): no connect may store a client past this point. */
  private closed = false;

  /**
   * Every connected plugin server's tools, qualified and in a canonical order.
   * Never throws — a broken plugin yields fewer tools, never an error.
   */
  getTools(): Promise<Record<string, Tool>> {
    // After shutdown there is nothing to serve and nothing may be spawned.
    if (this.closed) return Promise.resolve(this.merged);
    // Coalesced: a chat turn and a compaction can both be inside collectTools()
    // at once, and two concurrent refreshes would spawn duplicate children.
    if (!this.inflight) {
      this.inflight = this.refresh()
        .catch((error: unknown) => {
          logger.error({ err: error }, '[PluginMCP] refresh failed');
          return this.merged;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  /**
   * Per-server outcomes for whatever is currently connected. Reflects the last
   * refresh, so callers that need it to be current should `await getTools()`
   * first — that is what makes a "failed to start" attributable in the API
   * rather than only in the logs.
   */
  getServerStatuses(): ServerStatus[] {
    // Compare the keys, not the `[key, Entry]` tuples: a default sort would
    // stringify each tuple and only happen to work because every Entry renders
    // as "[object Object]", leaving the key to decide.
    const byKey = ([a]: [string, Entry], [b]: [string, Entry]) => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.entries.entries()].sort(byKey).map(([key, entry]) => {
      const [pluginId, serverName] = splitKey(key);
      return entry.status === 'ready'
        ? { pluginId, serverName, status: 'ready' as const }
        : { pluginId, serverName, status: 'failed' as const, error: entry.error };
    });
  }

  /** Close every live client. Bounded, and safe to call more than once. */
  async shutdownAll(): Promise<void> {
    // Mark first: a connect still in flight must not re-insert its client after
    // the map is cleared — nothing would ever close that one again.
    this.closed = true;
    const clients = [...this.entries.values()].flatMap((e) =>
      e.status === 'ready' ? [e.client] : [],
    );
    this.entries.clear();
    this.configs.clear();
    this.merged = {};
    if (clients.length === 0) return;

    logger.info('[PluginMCP] closing %d plugin MCP server(s)', clients.length);
    await Promise.race([
      Promise.allSettled(clients.map((c) => c.close())),
      // .unref() so a fast close isn't held open by the timer itself.
      new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS).unref()),
    ]);
  }

  /** Drop all cached state without closing anything. Tests only. */
  reset(): void {
    this.entries.clear();
    this.configs.clear();
    this.merged = {};
    this.inflight = null;
    this.closed = false;
  }

  // -------------------------------------------------------------------------

  private async refresh(): Promise<Record<string, Tool>> {
    const desired = await this.scanDesired();

    // Drop anything that vanished or whose config changed.
    let changed = false;
    for (const [key, entry] of [...this.entries]) {
      const want = desired.get(key);
      if (want && want.fingerprint === entry.fingerprint) continue;
      if (entry.status === 'ready') {
        void entry.client.close().catch(() => {});
      }
      this.entries.delete(key);
      changed = true;
    }

    // Connect what isn't connected, plus any failure whose backoff has elapsed.
    // The failed entry is left in place rather than deleted, so `connect` can
    // read its attempt count and keep widening the interval.
    const now = Date.now();
    const missing = [...desired].filter(([key]) => {
      const entry = this.entries.get(key);
      if (!entry) return true;
      return entry.status === 'failed' && entry.nextRetryAt <= now;
    });
    if (missing.length > 0) changed = true;
    await Promise.allSettled(missing.map(([key, want]) => this.connect(key, want)));

    if (changed) this.rebuild();
    return this.merged;
  }

  /** The servers that *should* be connected, from what is on disk right now. */
  private async scanDesired(): Promise<Map<string, DesiredServer>> {
    const desired = new Map<string, DesiredServer>();
    const seenPlugins = new Set<string>();

    for (const plugin of await pluginCatalogService.getPlugins()) {
      if (!plugin.mcpConfigPath) continue;
      seenPlugins.add(plugin.id);

      // Guarded because `throwIfNoEntry: false` suppresses only a missing
      // entry: a symlink loop (ELOOP) or a permission error still throws. The
      // catalog is mtime-cached on the plugins dir, so mcp.json can turn
      // unreadable *after* the scan that recorded its path — and one plugin's
      // bad file must not abort the refresh for every other plugin's servers.
      let stat: fs.Stats | undefined;
      try {
        stat = fs.statSync(plugin.mcpConfigPath, { throwIfNoEntry: false });
      } catch {
        stat = undefined;
      }
      if (!stat) continue;
      const fingerprint = `${stat.mtimeMs}:${stat.size}`;

      let cached = this.configs.get(plugin.id);
      if (!cached || cached.fingerprint !== fingerprint) {
        cached = { fingerprint, servers: this.parseConfig(plugin.id, plugin.dir, plugin.mcpConfigPath) };
        this.configs.set(plugin.id, cached);
      }

      for (const server of cached.servers) {
        desired.set(`${plugin.id}/${server.name}`, { pluginId: plugin.id, server, fingerprint });
      }
    }

    for (const id of [...this.configs.keys()]) {
      if (!seenPlugins.has(id)) this.configs.delete(id);
    }
    return desired;
  }

  private parseConfig(pluginId: string, pluginRoot: string, configPath: string): ResolvedServer[] {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
      logger.warn({ err: error }, '[PluginMCP] "%s": mcp.json could not be read', pluginId);
      return [];
    }

    const result = parseMcpJson(raw, {
      pluginId,
      pluginRoot,
      pluginData: resolvePluginDataDir(pluginId),
    });
    if (!result) {
      // An unusable file disables MCP for this plugin only; its skills are
      // unaffected (spec §7.2.2).
      logger.warn('[PluginMCP] "%s": mcp.json is invalid — no MCP servers loaded', pluginId);
      return [];
    }
    // Logged here rather than per refresh: we only re-parse when the file changes.
    for (const warning of result.warnings) logger.warn('[PluginMCP] "%s": %s', pluginId, warning);
    return result.servers;
  }

  private async connect(key: string, want: DesiredServer): Promise<void> {
    const { pluginId, server, fingerprint } = want;
    let clientPromise: Promise<MCPClient> | undefined;
    try {
      if (server.kind === 'stdio') {
        // The spec requires PLUGIN_DATA to exist and be writable before launch.
        fs.mkdirSync(resolvePluginDataDir(pluginId), { recursive: true });
      }

      clientPromise = experimental_createMCPClient({
        transport: buildTransport(server),
        clientName: 'prism-agent',
        onUncaughtError: (error: unknown) => {
          logger.warn({ err: error }, '[PluginMCP] %s errored; dropping until it reconnects', key);
          this.drop(key);
        },
      });
      const client = await withTimeout(clientPromise, CONNECT_TIMEOUT_MS);
      const tools = await withTimeout(client.tools(), CONNECT_TIMEOUT_MS);

      if (this.closed) {
        // shutdownAll() ran while this connect was in flight. Storing the entry
        // now would resurrect a client nothing will ever close again.
        void client.close().catch(() => {});
        return;
      }
      this.entries.set(key, { status: 'ready', fingerprint, client, tools });
      logger.info('[PluginMCP] %s connected (%d tool(s))', key, Object.keys(tools).length);
    } catch (error) {
      // A failure here does not mean no client. A timeout only loses the race —
      // `experimental_createMCPClient` can still resolve later with a live child
      // process (a slow-starting server, e.g. a first-run `uvx` download) — and
      // a failed `tools()` handshake leaves an already-connected client in hand.
      // Close whichever materializes, or it is unreferenced, unreachable by
      // shutdownAll(), and its child process is orphaned.
      void clientPromise?.then((c) => c.close()).catch(() => {});

      // Non-fatal by spec: other servers and component types keep loading. The
      // failure is retried on a widening interval rather than being final —
      // a cold `npx` download can lose the first race and win the next.
      const message = error instanceof Error ? error.message : String(error);
      const previous = this.entries.get(key);
      const attempts =
        previous?.status === 'failed' && previous.fingerprint === fingerprint
          ? previous.attempts + 1
          : 1;
      const delay = retryDelayMs(attempts);
      logger.warn(
        { err: error },
        '[PluginMCP] %s failed to start (attempt %d); retrying in %ds',
        key,
        attempts,
        Math.round(delay / 1000),
      );
      if (!this.closed) {
        this.entries.set(key, {
          status: 'failed',
          fingerprint,
          error: message,
          attempts,
          nextRetryAt: Date.now() + delay,
        });
      }
    }
  }

  /**
   * Forget one server, closing it first.
   *
   * Both halves matter. Closing before dropping the reference is what stops the
   * child process being orphaned — nothing else holds it, and `shutdownAll()`
   * closes only what is still in the map. Rebuilding immediately is what stops
   * the model being offered tools backed by a dead connection: a plugin deleted
   * from disk after its server errored appears in neither `entries` nor the next
   * refresh's desired set, so nothing there would mark the map dirty.
   */
  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (entry?.status === 'ready') {
      void entry.client.close().catch(() => {});
    }
    this.entries.delete(key);
    this.rebuild();
  }

  /**
   * Rebuild the merged map. Ordering is deterministic at every level — entry key
   * (plugin id, then server name) and then qualified tool name — because the key
   * order of this object is part of the prompt-cache prefix.
   */
  private rebuild(): void {
    const merged: Record<string, Tool> = {};
    for (const key of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(key);
      if (!entry || entry.status !== 'ready') continue;
      const [pluginId, serverName] = splitKey(key);

      const qualified = Object.keys(entry.tools)
        .map((raw) => [qualifyToolName(pluginId, serverName, raw), raw] as const)
        // Sort on the qualified name: truncation can reorder relative to the raw one.
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

      for (const [name, raw] of qualified) {
        if (name in merged) {
          logger.warn('[PluginMCP] %s: dropping tool "%s" — qualified name already taken', key, raw);
          continue;
        }
        merged[name] = entry.tools[raw];
      }
    }
    this.merged = merged;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildTransport(server: ResolvedServer) {
  if (server.kind !== 'stdio') {
    return { type: server.kind, url: server.url, headers: server.headers };
  }
  return new Experimental_StdioMCPTransport({
    command: server.command,
    args: server.args,
    env: server.env,
    cwd: server.cwd,
    // 'inherit' rather than 'pipe': the transport keeps the child process
    // private, so there is no way to drain a pipe from out here — and an
    // undrained pipe fills its buffer and blocks the server. Inheriting our
    // stderr costs the child's output being unstructured, but it cannot stall.
    stderr: 'inherit',
  });
}

/** `<pluginId>/<serverName>` — server names cannot contain a slash. */
function splitKey(key: string): [string, string] {
  const at = key.indexOf('/');
  return [key.slice(0, at), key.slice(at + 1)];
}

/**
 * `<pluginId>__<serverName>__<toolName>`, in the character set every provider
 * accepts and within the length cap.
 *
 * The three-part shape — and with it the per-plugin namespace — is guaranteed:
 * `sanitizeToolNameSegment` always yields a token, so no segment can vanish and
 * take its namespace with it. Shortening an over-long name is
 * `lib/tool-names.ts`'s job, shared with every other tool source.
 */
export function qualifyToolName(pluginId: string, serverName: string, toolName: string): string {
  return toModelToolName(
    [pluginId, serverName, toolName].map(sanitizeToolNameSegment).join('__'),
  );
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms).unref();
    }),
  ]);
}

export const pluginMcpService = new PluginMcpService();

// Exported for unit tests.
export const __test = { qualifyToolName, sanitizeSegment: sanitizeToolNameSegment };
