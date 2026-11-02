/**
 * Whether one request sends its MCP tools deferred, and everything that
 * follows from it: the tools block, the `load_tools` tool, the catalog, and
 * how a stored load replays.
 */

import { asSchema, type Tool, type ToolResultPart } from 'ai';
import { config } from '../../config';
import { contextWindowFor } from '../context-window';
import { LOAD_TOOLS_NAME } from '../llm-providers/deferred-tools';
import {
  isDeferredTool,
  mergeProviderOptions,
  type DeferredToolDefinition,
  type DeferredToolProtocol,
  type ToolLoad,
  type ToolLoader,
} from '../llm-providers/llm-provider';
import { trackEvent } from '../telemetry';
import { buildToolCatalog } from './catalog';
import { ToolIndex } from './tool-index';

// Real MCP schemas measured 2.2 to 2.4 characters per input token on Claude, as
// JSON is dense in tokens. Rounding down errs towards deferring.
const CHARS_PER_TOKEN = 2;

/** A stored tool call as history replays it. */
export interface ReplayedToolCall {
  id: string;
  tool: string;
  input: unknown;
  output: string;
}

/** What a request with deferred tools adds to its prompt. */
export interface ToolSearchPrompt {
  /** The `# Tool Catalog` section, when active. */
  catalog?: string;
  /**
   * A stored `load_tools` call as this request sends it, or undefined for any
   * other call.
   */
  replayToolCall?: (
    call: ReplayedToolCall,
  ) => { id: string; input: unknown; output: ToolResultPart['output'] } | undefined;
}

export interface ToolSearchPlan extends ToolSearchPrompt {
  tools: Record<string, Tool>;
  active: boolean;
  /** The tools sent deferred. */
  deferred: string[];
  /**
   * A summary request declares the tools under tool choice 'auto' and refuses
   * every call, since the SDK sends no tools block under 'none'.
   */
  summaryDeclaresTools: boolean;
  /**
   * The prompt for a conversation's declared list (`tool-ledger.service.ts`),
   * which keeps a tool this turn does not offer. `joinedLater` are the tools an
   * announcement loads, which the catalog leaves out.
   */
  promptFor: (sent: Record<string, Tool>, joinedLater: ReadonlySet<string>) => Promise<ToolSearchPrompt>;
}

export interface PlanToolSearchInput {
  tools: Record<string, Tool>;
  /** Names in `tools` that may be sent deferred. */
  deferrable: readonly string[];
  protocol: DeferredToolProtocol | undefined;
  modelId: string;
  telemetry: { userId: string; agentId: string; mode: string };
}

async function definitionOf(name: string, tool: Tool): Promise<DeferredToolDefinition> {
  const schema = await asSchema(tool.inputSchema).jsonSchema;
  return {
    name,
    description: typeof tool.description === 'string' ? tool.description : '',
    parameters: schema as Record<string, unknown>,
  };
}

/** A char/4 estimate of what the definitions add to every request. */
export function estimateDefinitionTokens(definitions: readonly DeferredToolDefinition[]): number {
  const chars = definitions.reduce(
    (sum, d) => sum + d.name.length + d.description.length + JSON.stringify(d.parameters).length,
    0,
  );
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Defer when the definitions take more than the threshold's share of the
 * window. Every model with a protocol has a known window; one without defers.
 */
export function exceedsThreshold(tokens: number, modelId: string, percent: number): boolean {
  const window = contextWindowFor(modelId)?.tokens;
  if (!window) return true;
  return tokens > (window * percent) / 100;
}

/** The stored result of a `load_tools` call, or undefined when it holds none. */
export function parseStoredLoad(output: string): ToolLoad | undefined {
  try {
    const value = JSON.parse(output) as Partial<ToolLoad> | null;
    if (!value || !Array.isArray(value.loaded)) return undefined;
    const strings = (list: unknown): string[] =>
      Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    return {
      loaded: strings(value.loaded),
      unmatched: strings(value.unmatched),
      suggestions: strings(value.suggestions),
    };
  } catch {
    return undefined;
  }
}

const LOAD_TOOLS_DESCRIPTION =
  'Load tools listed in the Tool Catalog so you can call them. Pass `names` from the catalog, ' +
  'or a `query` that says what the tools do; a query loads the best few matches. ' +
  'A loaded tool stays loaded in later turns.';

export async function planToolSearch(input: PlanToolSearchInput): Promise<ToolSearchPlan> {
  const inactive: ToolSearchPlan = {
    tools: input.tools,
    active: false,
    deferred: [],
    summaryDeclaresTools: false,
    promptFor: async () => ({}),
  };
  const { protocol } = input;
  if (!protocol || config.toolSearch === 'off') return inactive;

  const deferrable = input.deferrable.filter((name) => name in input.tools);
  if (deferrable.length === 0) return inactive;

  const definitions = await Promise.all(
    deferrable.map((name) => definitionOf(name, input.tools[name])),
  );
  const tokens = estimateDefinitionTokens(definitions);
  if (!exceedsThreshold(tokens, input.modelId, config.toolSearchThresholdPercent)) return inactive;

  const index = new ToolIndex(definitions);
  const loader: ToolLoader = {
    description: LOAD_TOOLS_DESCRIPTION,
    definition: (name) => index.definition(name),
    load: (request) => {
      const load = index.load(request);
      const match = request.names?.length ? (request.query ? 'both' : 'names') : 'query';
      trackEvent('tools loaded', input.telemetry.userId, {
        'agent.id': input.telemetry.agentId,
        'invoke.mode': input.telemetry.mode,
        'tool.count': String(load.loaded.length),
        'deferred.count': String(index.size),
        match,
      });
      return load;
    },
  };

  const deferredSet = new Set(deferrable);
  const tools: Record<string, Tool> = {};
  for (const [name, tool] of Object.entries(input.tools)) {
    tools[name] = deferredSet.has(name)
      ? { ...tool, providerOptions: mergeProviderOptions(tool.providerOptions, protocol.deferredTool) }
      : tool;
  }
  tools[LOAD_TOOLS_NAME] = protocol.loadTool(loader);

  // A load result naming a tool the request does not declare fails it.
  const replayFor = (sent: Record<string, Tool>): ToolSearchPrompt['replayToolCall'] => (call) => {
    if (call.tool !== LOAD_TOOLS_NAME) return undefined;
    const stored = parseStoredLoad(call.output);
    if (!stored) return undefined;
    const result = { ...stored, loaded: stored.loaded.filter((name) => name in sent) };
    return protocol.replay({ id: call.id, input: call.input, result }, loader);
  };

  return {
    tools,
    active: true,
    deferred: deferrable,
    summaryDeclaresTools: !protocol.keepsToolsUnderNone,
    catalog: buildToolCatalog(definitions),
    replayToolCall: replayFor(tools),
    promptFor: async (sent, joinedLater) => {
      const listed = Object.keys(sent).filter(
        (name) => name !== LOAD_TOOLS_NAME && !joinedLater.has(name) && isDeferredTool(sent[name]),
      );
      return {
        catalog: buildToolCatalog(await Promise.all(listed.map((name) => definitionOf(name, sent[name])))),
        replayToolCall: replayFor(sent),
      };
    },
  };
}
