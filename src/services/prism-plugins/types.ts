/**
 * The Prism Plugin contract — what a plugin's `server/index.ts` receives and
 * what it returns. Also the source of the `.d.ts` written into the plugins dir
 * at boot, so a plugin's own sources typecheck against the runtime they run in.
 *
 * A plugin default-exports a factory taking a `PrismPluginContext` and returning
 * a `PrismPlugin`. The factory runs once per process: a plugin change restarts
 * the runtime, which is what keeps the tools block byte-identical between turns.
 */

/** HTTP methods a plugin route may claim. */
export type PrismPluginMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * What a route handler is given. Deliberately not express's `Request`: a plugin
 * that closed over express internals would break on an express major, and the
 * three fields below are what a page's own endpoint actually reads.
 */
export interface PrismPluginRequest {
  /** Path parameters, when the route path declares any (`/item/:id`). */
  params: Record<string, string>;
  /** Parsed query string. Repeated keys arrive as an array, as express gives them. */
  query: Record<string, string | string[] | undefined>;
  /** Parsed JSON body, or undefined when the request carried none. */
  body?: unknown;
}

/**
 * What a handler may answer with. Returning a plain value sends it as JSON with
 * a 200; returning a `PrismPluginResponse` sets the status and headers. A
 * handler that throws becomes a 500 with its message, logged under the plugin's
 * own tag.
 */
export interface PrismPluginResponse {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface PrismPluginRoute {
  method: PrismPluginMethod;
  /**
   * Path relative to the plugin's own prefix, leading slash included —
   * `/summary` is served at `/agents/prism-plugins/<id>/api/summary`. Express
   * path syntax, so `/item/:id` populates `params`.
   */
  path: string;
  handler: (req: PrismPluginRequest) => Promise<unknown> | unknown;
}

/**
 * A tool the agent can call. `name` is local to the plugin and reaches the model
 * as `<pluginId>__<name>`, so two plugins may both declare `summary`.
 *
 * `inputSchema` is JSON Schema rather than a zod schema. Nothing installs
 * dependencies for a plugin, so a plugin cannot import zod or the AI SDK — the
 * runtime converts this to the schema the provider needs.
 */
export interface PrismPluginTool {
  name: string;
  /** What the tool does, written for the model. This is how it decides to call it. */
  description: string;
  /** JSON Schema for the arguments. Omit for a tool that takes none. */
  inputSchema?: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
}

/**
 * Periodic work the runtime runs for the plugin. `schedule` is a five- or
 * six-field cron expression. An overlapping tick is skipped rather than queued,
 * so a job that runs long cannot pile up behind itself.
 */
export interface PrismPluginJob {
  name: string;
  schedule: string;
  run: () => Promise<void> | void;
}

/** Read-only views of agent state, for a page that shows more than its own data. */
export interface PrismPluginAgentApi {
  /** Identity and the heartbeat's configured state. */
  get(): Promise<{
    id: string;
    name: string;
    userId: string;
    heartbeatStatus: 'ENABLED' | 'STOPPED';
    heartbeatIntervalMs: number;
  }>;
  /** Conversation threads, newest first. */
  listThreads(limit?: number): Promise<
    Array<{ id: string; title: string | null; createdAt: Date; updatedAt: Date }>
  >;
  /** Messages on one thread, oldest first. */
  listMessages(
    threadId: string,
    limit?: number,
  ): Promise<Array<{ id: string; role: string; content: string; createdAt: Date }>>;
  /** Token spend over the last `windowHours`. */
  llmUsage(windowHours?: number): Promise<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    calls: number;
  }>;
}

/**
 * A plugin's own logger, tagged with its id so its lines are attributable.
 * `data` is logged as structured fields; an `Error` passed there goes through
 * the runtime's redaction serializer.
 */
export interface PrismPluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface PrismPluginContext {
  /** The plugin's directory name, and the prefix its tools and routes carry. */
  id: string;
  /** The plugin's own persistent directory. It exists by the time the factory runs. */
  dataDir: string;
  /** The plugin's source directory, for reading files it ships. */
  pluginDir: string;
  logger: PrismPluginLogger;
  agent: PrismPluginAgentApi;
}

export interface PrismPlugin {
  routes?: PrismPluginRoute[];
  tools?: PrismPluginTool[];
  jobs?: PrismPluginJob[];
}

/** What a plugin's `server/index.ts` default-exports. */
export type PrismPluginFactory = (
  ctx: PrismPluginContext,
) => PrismPlugin | Promise<PrismPlugin>;

/** The manifest, after validation. */
export interface PrismPluginManifest {
  apiVersion: 1;
  name: string;
  version?: string;
  description?: string;
  /** A lucide icon name for the nav entry. Unknown names fall back host-side. */
  icon?: string;
}

/** The `apiVersion` values this runtime implements. */
export const SUPPORTED_API_VERSIONS = [1] as const;

/** The manifest filename inside a plugin directory. */
export const MANIFEST_FILENAME = 'prism-plugin.json';
