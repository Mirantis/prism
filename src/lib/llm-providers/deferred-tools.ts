/**
 * Deferred tools: a tool whose schema the provider keeps out of the model's
 * context until a `load_tools` result names it. Each vendor names a tool
 * differently in that result, so each has a protocol here.
 */

import { openai } from '@ai-sdk/openai';
import { tool, type JSONValue, type Tool, type ToolResultPart } from 'ai';
import { z } from 'zod';
import type {
  DeferredToolProtocol,
  ToolLoad,
  ToolLoader,
  ToolLoadRequest,
} from './llm-provider';
import { bareModelId } from './tool-changes';

export const LOAD_TOOLS_NAME = 'load_tools';

/**
 * The oldest version of each family measured to load a deferred tool and to
 * replay that load from stored history: Claude 4.7 through 5.5 on Bedrock's
 * Anthropic Messages path, and GPT 5.6 through 6.1 under `store: true`. A later
 * version defers without a code change; gpt-5.5 and gpt-5.4 fail the replay.
 */
const CLAUDE_FLOOR: Version = [4, 7];
const GPT_FLOOR: Version = [5, 6];

type Version = readonly [major: number, minor: number];

/** `claude-opus-4-7`, `claude-opus-5`; a date suffix is not a minor version. */
const CLAUDE_VERSION = /^claude-[a-z]+-(\d+)(?:-(\d{1,2})(?!\d))?/;
/** `gpt-5.6-sol`, `gpt-6-luna`. */
const GPT_VERSION = /^gpt-(\d+)(?:\.(\d+))?(?![\d.])/;

function atLeast(modelId: string, pattern: RegExp, floor: Version): boolean {
  const match = pattern.exec(modelId);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > floor[0] || (major === floor[0] && minor >= floor[1]);
}

export function supportsAnthropicDeferredTools(modelId: string): boolean {
  return atLeast(bareModelId(modelId), CLAUDE_VERSION, CLAUDE_FLOOR);
}

export function supportsOpenAiDeferredTools(modelId: string): boolean {
  return atLeast(modelId, GPT_VERSION, GPT_FLOOR);
}

const refusingModels = new Set<string>();

/**
 * A provider's `deferredTools`: the protocol on a model the rule admits, until
 * the API refuses a request that deferred tools on that model.
 */
export function deferredToolsWhen(
  admits: (modelId: string) => boolean,
  protocol: DeferredToolProtocol,
): (modelId: string) => DeferredToolProtocol | undefined {
  return (modelId) => (admits(modelId) && !refusingModels.has(modelId) ? protocol : undefined);
}

/**
 * Sends every tool in full to `modelId` until the process restarts. True when
 * the model was deferring until now.
 */
export function recordDeferralRefusal(modelId: string): boolean {
  if (refusingModels.has(modelId)) return false;
  refusingModels.add(modelId);
  return true;
}

type ToolResultOutput = ToolResultPart['output'];

const LOAD_REQUEST_SCHEMA = z.object({
  names: z.array(z.string()).optional().describe('Exact tool names from the tool catalog.'),
  query: z.string().optional().describe('Keywords naming what the tools do.'),
});

/** What the model reads when a load names no tool. */
export function describeLoad(load: ToolLoad): string {
  const parts: string[] = [];
  if (load.loaded.length > 0) parts.push(`Loaded: ${load.loaded.join(', ')}.`);
  if (load.unmatched.length > 0) parts.push(`No tool matched: ${load.unmatched.join(', ')}.`);
  if (load.suggestions.length > 0) parts.push(`Similar tools: ${load.suggestions.join(', ')}.`);
  return parts.length > 0 ? parts.join(' ') : 'No tool matched. Name a tool from the catalog.';
}

/**
 * A Messages API tool result holds either `tool_reference` blocks or text,
 * never both, so a load that found tools names only them.
 */
function anthropicOutput(load: ToolLoad): ToolResultOutput {
  if (load.loaded.length === 0) return { type: 'text', value: describeLoad(load) };
  return {
    type: 'content',
    value: load.loaded.map((toolName) => ({
      type: 'custom' as const,
      providerOptions: { anthropic: { type: 'tool-reference', toolName } },
    })),
  };
}

export const ANTHROPIC_DEFERRED_TOOLS: DeferredToolProtocol = {
  deferredTool: { anthropic: { deferLoading: true } },
  keepsToolsUnderNone: false,
  loadTool: (loader) =>
    tool({
      description: loader.description,
      inputSchema: LOAD_REQUEST_SCHEMA,
      execute: async (request) => loader.load(request),
      toModelOutput: ({ output }) => anthropicOutput(output),
    }),
  replay: (call) => ({ id: call.id, input: call.input, output: anthropicOutput(call.result) }),
};

/** A client tool search call's input: the model's arguments and the call id. */
interface OpenAiSearchInput {
  arguments?: unknown;
  call_id?: string | null;
}

function openAiRequest(input: OpenAiSearchInput): ToolLoadRequest {
  const parsed = LOAD_REQUEST_SCHEMA.safeParse(input.arguments);
  return parsed.success ? parsed.data : {};
}

function openAiOutput(load: ToolLoad, loader: ToolLoader): ToolResultOutput {
  const tools = load.loaded.flatMap((name) => {
    const definition = loader.definition(name);
    if (!definition) return [];
    return [{ type: 'function', ...definition, strict: false, defer_loading: true }];
  });
  return { type: 'json', value: { tools } as JSONValue };
}

/**
 * The Responses API takes a client `tool_search_call` id only when it starts
 * with `tsc`; under `store: true` any other id is read as a stored item.
 */
function openAiCallId(id: string): string {
  return `tsc_${id.replace(/[^A-Za-z0-9]/g, '')}`;
}

export const OPENAI_DEFERRED_TOOLS: DeferredToolProtocol = {
  deferredTool: { openai: { deferLoading: true } },
  keepsToolsUnderNone: true,
  loadTool: (loader) =>
    // The SDK types the result as the wire's `{ tools }`; the runtime keeps the
    // `ToolLoad` as the call's result and `toModelOutput` builds the wire shape.
    openai.tools.toolSearch({
      execution: 'client',
      description: loader.description,
      parameters: z.toJSONSchema(LOAD_REQUEST_SCHEMA) as Record<string, unknown>,
      execute: (async (input: OpenAiSearchInput) => loader.load(openAiRequest(input))) as never,
      toModelOutput: ({ output }) => openAiOutput(output as unknown as ToolLoad, loader),
    }) as unknown as Tool,
  replay: (call, loader) => {
    const id = openAiCallId(call.id);
    const args = (call.input as OpenAiSearchInput | undefined)?.arguments ?? {};
    return {
      id,
      input: { arguments: args, call_id: id },
      output: openAiOutput(call.result, loader),
    };
  },
};

/**
 * The Realtime API has no deferral, so a voice session declares the deferred
 * tools itself when a load names them (`services/voice/realtime-tools.ts`).
 * A voice session keeps no history, so nothing replays.
 */
export const REALTIME_DEFERRED_TOOLS: DeferredToolProtocol = {
  deferredTool: {},
  keepsToolsUnderNone: true,
  loadTool: (loader) =>
    tool({
      description: loader.description,
      inputSchema: LOAD_REQUEST_SCHEMA,
      execute: async (request) => loader.load(request),
    }),
  replay: (call) => ({ id: call.id, input: call.input, output: { type: 'text', value: describeLoad(call.result) } }),
};
