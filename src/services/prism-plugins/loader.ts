/**
 * Loads a built plugin server module and validates what it hands back.
 *
 * The module runs in this process, so its factory is called exactly once, at
 * boot. That is what makes a plugin change a restart rather than a reload: a
 * second call would leave the first call's timers and handles behind, and the
 * tools block the model sees would change mid-conversation.
 *
 * Every declaration is checked before it is accepted. A plugin is written by an
 * agent from a prompt, so a route with no handler or a tool with no description
 * is a likely first draft — and a clear message on the plugin's own page is how
 * it gets corrected.
 */

import { pathToFileURL } from 'url';
import type { Tool } from 'ai';
import { logger } from '../../logger';
import { toModelToolName } from '../../lib/tool-names';
import type {
  PrismPlugin,
  PrismPluginContext,
  PrismPluginJob,
  PrismPluginMethod,
  PrismPluginRoute,
} from './types';

const METHODS: readonly PrismPluginMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

/** A tool's local name, before the plugin prefix goes on. */
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,48}$/;

export interface LoadedPlugin {
  routes: PrismPluginRoute[];
  /** Keyed by the name the model sees: `<pluginId>__<tool>`. */
  tools: Record<string, Tool>;
  jobs: PrismPluginJob[];
  /** Problems that kept part or all of the module from loading. */
  errors: string[];
}

const EMPTY: LoadedPlugin = { routes: [], tools: {}, jobs: [], errors: [] };

/**
 * Import one built server module and call its factory. Never throws: a module
 * that fails to import, a factory that throws, or a declaration of the wrong
 * shape all come back as strings on `errors`, and the other plugins load.
 */
export async function loadPluginServer(
  serverPath: string,
  ctx: PrismPluginContext,
): Promise<LoadedPlugin> {
  let factory: unknown;
  try {
    // A file URL rather than a path: on Windows a bare absolute path is not a
    // valid ESM specifier.
    const mod = (await import(pathToFileURL(serverPath).href)) as { default?: unknown };
    factory = mod.default;
  } catch (error: unknown) {
    return { ...EMPTY, errors: [`server module failed to load: ${message(error)}`] };
  }

  if (typeof factory !== 'function') {
    return {
      ...EMPTY,
      errors: ['server/index.ts must default-export a function taking the plugin context'],
    };
  }

  let declared: unknown;
  try {
    declared = await (factory as (c: PrismPluginContext) => unknown)(ctx);
  } catch (error: unknown) {
    return { ...EMPTY, errors: [`the plugin factory threw: ${message(error)}`] };
  }

  if (declared === undefined || declared === null) return { ...EMPTY };
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    return { ...EMPTY, errors: ['the plugin factory must return an object'] };
  }

  return await collect(declared as PrismPlugin, ctx);
}

async function collect(declared: PrismPlugin, ctx: PrismPluginContext): Promise<LoadedPlugin> {
  const errors: string[] = [];
  const routes: PrismPluginRoute[] = [];
  const tools: Record<string, Tool> = {};
  const jobs: PrismPluginJob[] = [];

  for (const [index, route] of (declared.routes ?? []).entries()) {
    const problem = routeProblem(route);
    if (problem) {
      errors.push(`routes[${index}]: ${problem}`);
      continue;
    }
    routes.push({ method: route.method, path: route.path, handler: route.handler });
  }

  for (const [index, declaration] of (declared.tools ?? []).entries()) {
    const problem = toolProblem(declaration);
    if (problem) {
      errors.push(`tools[${index}]: ${problem}`);
      continue;
    }
    // Namespaced and then run through the shared naming rule, so an over-long
    // combination is truncated with a stable digest rather than rejected by the
    // provider — which would fail the whole request, not just this tool.
    const modelName = toModelToolName(`${ctx.id}__${declaration.name}`);
    if (modelName in tools) {
      errors.push(`tools[${index}]: "${declaration.name}" is declared twice`);
      continue;
    }
    tools[modelName] = await buildTool(declaration, ctx);
  }

  for (const [index, job] of (declared.jobs ?? []).entries()) {
    const problem = jobProblem(job);
    if (problem) {
      errors.push(`jobs[${index}]: ${problem}`);
      continue;
    }
    jobs.push({ name: job.name, schedule: job.schedule, run: job.run });
  }

  const unknownKeys = Object.keys(declared)
    .filter((k) => !['routes', 'tools', 'jobs'].includes(k))
    .sort();
  if (unknownKeys.length > 0) {
    logger.warn(
      '[PrismPlugins] "%s": ignoring unknown declaration(s): %s',
      ctx.id,
      unknownKeys.join(', '),
    );
  }

  return { routes, tools, jobs, errors };
}

function routeProblem(route: PrismPluginRoute | undefined): string | null {
  if (!route || typeof route !== 'object') return 'must be an object';
  if (!METHODS.includes(route.method)) {
    return `method must be one of ${METHODS.join(', ')}`;
  }
  if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
    return 'path must be a string starting with "/"';
  }
  if (typeof route.handler !== 'function') return 'handler must be a function';
  return null;
}

function toolProblem(declaration: { name?: unknown; description?: unknown; inputSchema?: unknown; execute?: unknown } | undefined): string | null {
  if (!declaration || typeof declaration !== 'object') return 'must be an object';
  if (typeof declaration.name !== 'string' || !TOOL_NAME_RE.test(declaration.name)) {
    return 'name must start with a letter and hold only letters, digits, "_" or "-"';
  }
  // A tool the model cannot tell apart from another is worse than no tool, and
  // the description is the only thing it has to go on.
  if (typeof declaration.description !== 'string' || declaration.description.trim() === '') {
    return 'description is required — it is what the model reads to decide whether to call the tool';
  }
  if (typeof declaration.execute !== 'function') return 'execute must be a function';
  if (
    declaration.inputSchema !== undefined &&
    (typeof declaration.inputSchema !== 'object' ||
      declaration.inputSchema === null ||
      Array.isArray(declaration.inputSchema))
  ) {
    return 'inputSchema must be a JSON Schema object when present';
  }
  return null;
}

function jobProblem(job: PrismPluginJob | undefined): string | null {
  if (!job || typeof job !== 'object') return 'must be an object';
  if (typeof job.name !== 'string' || job.name.trim() === '') return 'name is required';
  if (typeof job.schedule !== 'string' || job.schedule.trim() === '') {
    return 'schedule is required — a five- or six-field cron expression';
  }
  if (typeof job.run !== 'function') return 'run must be a function';
  return null;
}

/**
 * Wrap a plugin's declaration as an AI SDK tool. A tool that throws answers
 * with its message rather than failing the turn — the same self-correcting
 * shape the built-in tools use, so the model can read the error and retry.
 */
async function buildTool(
  declaration: {
    name: string;
    description: string;
    inputSchema?: Record<string, unknown>;
    execute: (input: Record<string, unknown>) => Promise<unknown> | unknown;
  },
  ctx: PrismPluginContext,
): Promise<Tool> {
  // Imported here rather than at the top: this module is reachable from the
  // WebSocket gateway and the boot census, neither of which has any use for the
  // AI SDK. Only a plugin that declares a tool loads it.
  const { jsonSchema, tool } = await import('ai');
  const schema = declaration.inputSchema ?? { type: 'object', properties: {} };
  return tool({
    description: declaration.description,
    inputSchema: jsonSchema(schema),
    execute: async (input: unknown) => {
      try {
        return await declaration.execute((input ?? {}) as Record<string, unknown>);
      } catch (error: unknown) {
        const detail = message(error);
        ctx.logger.warn(`tool "${declaration.name}" failed: ${detail}`);
        return { error: detail };
      }
    },
  });
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const __test = { routeProblem, toolProblem, jobProblem, collect };
