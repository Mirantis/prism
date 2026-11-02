/**
 * The tools each conversation declares to the model.
 *
 * The tools block is the first element of the cached prompt prefix, so a
 * change to it invalidates the whole cache of the conversation. On a model that
 * takes mid-conversation tool changes, a conversation therefore declares one
 * list for its life: a tool joins the list the first time a turn offers it, and
 * stays. What changes between turns is which declared tools are available, and
 * each change is an announcement in the history that every later request
 * replays after the same row. A tool whose definition changes gets the new one:
 * one cache miss, as for a new tool.
 *
 * A tool that goes away keeps its definition, description included, so an
 * outage keeps the cache. Every call to it is refused. The definition goes when
 * the runtime restarts or the conversation leaves the list.
 *
 * In memory, one record per thread and model, since the cache is per model
 * too: a thread-bound cron task on its own model keeps a list of its own. A
 * restart or an eviction starts a new list: one cache miss.
 */

import { asSchema, stepCountIs, type SystemModelMessage, type Tool } from 'ai';
import {
  isDeferredTool,
  mergeProviderOptions,
  type ToolChange,
  type ToolChangeProtocol,
} from '../lib/llm-providers/llm-provider';

/** A tool-change announcement and the history row it follows; null when it counts from the start. */
export interface AnchoredToolChange {
  afterRowId: string | null;
  message: SystemModelMessage;
}

/** What one request of a conversation sends. */
export interface DeclaredTools {
  /** The declared list, in declaration order. A tool not available now refuses every call. */
  tools: Record<string, Tool>;
  /** Declared tools that load only when an addition names them. */
  deferred: ReadonlySet<string>;
  /** Every announcement the request has, oldest first. */
  toolChanges: AnchoredToolChange[];
}

interface ConversationTools {
  /** The definition of each declared tool, in declaration order. */
  definitions: Map<string, Tool>;
  /** What the model sees of each definition, to tell a changed one (`wireSignature`). */
  signatures: Map<string, string>;
  /** The tools of the conversation's first request, which load without an addition. */
  initial: ReadonlySet<string>;
  /** The tools available where the replayed history starts: `initial` after the folded announcements. */
  atStart: Set<string>;
  /** Announcements whose row is still in the history, oldest first. */
  announcements: Array<{ afterRowId: string | null; changes: ToolChange[] }>;
}

/**
 * Conversations kept. Only a thread that takes another turn reads its record,
 * so the least recently used one loses least: one cache miss on its next turn.
 */
const MAX_CONVERSATIONS = 100;

/** The parts of a tool the model sees. Everything else, `execute` included, comes from the turn. */
const WIRE_FIELDS = [
  'type',
  'description',
  'inputSchema',
  'inputExamples',
  'strict',
  'providerOptions',
] as const;

function wireDefinition(tool: Tool): Tool {
  const definition: Record<string, unknown> = {};
  for (const field of WIRE_FIELDS) {
    const value = (tool as Record<string, unknown>)[field];
    if (value !== undefined) definition[field] = value;
  }
  return definition as Tool;
}

/** The definition as the model sees it, in one string. */
async function wireSignature(tool: Tool): Promise<string> {
  const { type, description, inputExamples, strict } = tool as Record<string, unknown>;
  const schema = await asSchema(tool.inputSchema).jsonSchema;
  return JSON.stringify([type, description, schema, inputExamples, strict, isDeferredTool(tool)]);
}

function refusal(name: string): Tool['execute'] {
  return async () => {
    throw new Error(`The ${name} tool is not available in this conversation now.`);
  };
}

/**
 * The tool options of a summary request (a compaction, the early-stop summary)
 * in a conversation with a declared list. A summary request must run no tool,
 * but under tool choice 'none' the provider SDK sends no tools block, so the
 * history's announcements would name tools the request does not declare, and
 * the request would miss the cached prefix that starts with them. The request
 * therefore declares the list under 'auto', and refuses every call.
 */
export function summaryToolOptions(tools: Record<string, Tool>) {
  return {
    tools: Object.fromEntries(
      Object.entries(tools).map(([name, tool]) => [name, { ...tool, execute: refusal(name) } as Tool]),
    ),
    toolChoice: 'auto' as const,
    allowSystemInMessages: true,
    // A model that calls a tool anyway gets the refusal and answers in the second step.
    stopWhen: stepCountIs(2),
  };
}

/** Additions, then removals, each in declaration order, so the bytes do not follow collection order. */
function changesBetween(
  order: Iterable<string>,
  from: ReadonlySet<string>,
  to: ReadonlySet<string>,
): ToolChange[] {
  const names = [...order];
  return [
    ...names.filter((name) => to.has(name) && !from.has(name))
      .map((toolName) => ({ type: 'tool_addition' as const, toolName })),
    ...names.filter((name) => from.has(name) && !to.has(name))
      .map((toolName) => ({ type: 'tool_removal' as const, toolName })),
  ];
}

function apply(available: Set<string>, changes: ToolChange[]): void {
  for (const change of changes) {
    if (change.type === 'tool_addition') available.add(change.toolName);
    else available.delete(change.toolName);
  }
}

export class ToolLedgerService {
  /** Keyed by model and thread id; iteration order is recency of use. */
  private readonly conversations = new Map<string, ConversationTools>();

  /**
   * Record which tools this turn of the conversation offers, and return what
   * its request sends. `rowIds` are the history rows the request replays,
   * oldest first; a change this turn is announced after the last of them.
   */
  async declare(input: {
    threadId: string;
    modelId: string;
    protocol: ToolChangeProtocol;
    available: Record<string, Tool>;
    rowIds: string[];
  }): Promise<DeclaredTools> {
    const { protocol, available, rowIds } = input;
    const names = Object.keys(available);
    const key = `${input.modelId} ${input.threadId}`;
    // Awaited before the record is read, so the update below runs in one tick.
    const signatures = await Promise.all(names.map((name) => wireSignature(available[name])));

    const conversation: ConversationTools = this.conversations.get(key) ?? {
      definitions: new Map(),
      signatures: new Map(),
      initial: new Set(names),
      atStart: new Set(names),
      announcements: [],
    };
    this.conversations.delete(key);
    this.conversations.set(key, conversation);
    if (this.conversations.size > MAX_CONVERSATIONS) {
      const [oldest] = this.conversations.keys();
      this.conversations.delete(oldest);
    }

    this.fold(conversation, rowIds);

    // A new tool joins at the end; a changed one keeps its place.
    names.forEach((name, index) => {
      if (conversation.signatures.get(name) === signatures[index]) return;
      const definition = wireDefinition(available[name]);
      conversation.signatures.set(name, signatures[index]);
      conversation.definitions.set(name, conversation.initial.has(name) ? definition : {
        ...definition,
        providerOptions: mergeProviderOptions(definition.providerOptions, protocol.deferredTool),
      } as Tool);
    });

    const current = new Set(conversation.atStart);
    for (const announcement of conversation.announcements) apply(current, announcement.changes);
    const changes = changesBetween(conversation.definitions.keys(), current, new Set(names));
    if (changes.length > 0) {
      conversation.announcements.push({ afterRowId: rowIds.at(-1) ?? null, changes });
    }

    return this.view(conversation, protocol, available);
  }

  /**
   * What the conversation's next request would declare, with no tool
   * available and nothing recorded; undefined when it has no list for `modelId`.
   */
  peek(input: { threadId: string; modelId: string; protocol: ToolChangeProtocol }): DeclaredTools | undefined {
    const conversation = this.conversations.get(`${input.modelId} ${input.threadId}`);
    return conversation && this.view(conversation, input.protocol, {});
  }

  /**
   * Fold every announcement up to the last one whose row left the history
   * (compaction) into `atStart`, so they become one announcement at the start.
   */
  private fold(conversation: ConversationTools, rowIds: string[]): void {
    const present = new Set(rowIds);
    let cut = 0;
    conversation.announcements.forEach((announcement, index) => {
      if (announcement.afterRowId === null || !present.has(announcement.afterRowId)) cut = index + 1;
    });
    for (const announcement of conversation.announcements.splice(0, cut)) {
      apply(conversation.atStart, announcement.changes);
    }
  }

  private view(
    conversation: ConversationTools,
    protocol: ToolChangeProtocol,
    available: Record<string, Tool>,
  ): DeclaredTools {
    const tools: Record<string, Tool> = {};
    const deferred = new Set<string>();
    for (const [name, definition] of conversation.definitions) {
      if (!conversation.initial.has(name)) deferred.add(name);
      const live = available[name];
      tools[name] = live
        ? ({ ...live, ...definition } as Tool)
        : ({ ...definition, execute: refusal(name) } as Tool);
    }

    const atStart = changesBetween(conversation.definitions.keys(), conversation.initial, conversation.atStart);
    const toolChanges: AnchoredToolChange[] = [
      ...(atStart.length > 0 ? [{ afterRowId: null, message: protocol.announce(atStart) }] : []),
      ...conversation.announcements.map((announcement) => ({
        afterRowId: announcement.afterRowId,
        message: protocol.announce(announcement.changes),
      })),
    ];
    return { tools, deferred, toolChanges };
  }
}

export const toolLedgerService = new ToolLedgerService();
