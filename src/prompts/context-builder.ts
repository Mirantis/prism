/**
 * Context Builder (Prompt Assembly)
 *
 * Builds the system prompt and conversation messages from pre-fetched context.
 * No data fetching here — that stays in the backend's context-builder.service.ts.
 */

import { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { config } from '../config';
import { memoryManagerService } from '../services/memory-manager.service';
import { SlackTriggerMessage } from '../types';

// Minimal type for conversation messages (matches Prisma's shape).
// toolCalls uses Prisma's Json? type (any JSON value); parseToolCalls() validates at runtime.
export interface ConversationMessage {
  id: string;
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  toolCalls?: unknown;
}

export interface AgentContext {
  soulMd: string;
  userMd: string;
  memoryMd: string;
  heartbeatMd: string;
  bootstrapMd: string;
  visionMd: string;
  agentMd: string;
  agentName: string;
  agentId: string;
  userId: string;
  proactivity: number;
  verbosity: number;
  model: string | null;
  isBootstrapPhase: boolean;
  conversationSummary: string | null;
  recentMessages: ConversationMessage[];
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
}

export interface SystemPromptPart {
  text: string;
  cacheable: boolean;
}

/**
 * Build system prompt as structured parts for granular cache control.
 *
 * Returns an array of parts, each marked as cacheable or not:
 * - Stable parts (identity, soul, user, memory, mode instructions, heartbeat context) → cacheable
 * - Dynamic parts (timestamp, recalled memories, bootstrap phase) → cacheable when recalled
 *   memories are present (safe because both are constant within a multi-step generateText() call)
 *
 * This allows the LLM provider to cache the large stable prefix independently
 * of the dynamic suffix, improving cross-conversation cache hit rates.
 */
export async function buildSystemPromptParts(
  context: AgentContext,
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent' = 'chat',
  slackMessages?: SlackTriggerMessage[],
  query?: string,
): Promise<SystemPromptPart[]> {
  const stableSections: string[] = [];
  const dynamicSections: string[] = [];

  // Bootstrap phase — dynamic (only during onboarding, chat mode only)
  if (context.isBootstrapPhase && mode === 'chat') {
    dynamicSections.push(`# Bootstrap Phase\n\n${context.bootstrapMd}`);
  }

  // Identity (authoritative, from DB — not overridable via soulMd)
  stableSections.push(`# Identity\n\nYou are **${context.agentName}**.`);

  // Soul (identity)
  stableSections.push(`# Soul\n\n${context.soulMd}`);

  // Agent guide (operating manual)
  if (context.agentMd && context.agentMd.trim()) {
    stableSections.push(`# Agent Guide\n\n${context.agentMd}`);
  }

  // User profile
  stableSections.push(`# User\n\n${context.userMd}`);

  // Memory (curated knowledge)
  stableSections.push(`# Memory\n\n${context.memoryMd}`);

  // Vision (user's goals — always included when present)
  if (context.visionMd && context.visionMd.trim()) {
    stableSections.push(`# Vision & Goals\n\n${context.visionMd}\n\n` +
      `**Your Mission**: Proactively advance this vision. During heartbeats, evaluate progress and identify opportunities.`);
  }

  // Available infrastructure — language depends on deployment mode.
  // Multi-tenant agents reach infrastructure via dedicated Nexus MCP tools
  // (kubectl, connect-cluster, list_clusters, etc.). Single-agent containers
  // run inside a Nexus sandbox where credentials + configs flow into the
  // local shell instead, and the agent invokes CLIs via `shell_exec`.
  if (config.singleAgentMode) {
    stableSections.push(
      `# Connected Infrastructure\n\n` +
      `Credentials and config files for any integrations connected to this ` +
      `project are injected into your sandbox automatically. When a user asks ` +
      `you to interact with external resources, run the appropriate CLI via ` +
      `\`shell_exec\` — don't refuse based on assumed lack of access. If the ` +
      `CLI isn't on \`$PATH\`, try installing it via \`mise install <tool>@latest\` ` +
      `and then re-run. If an integration isn't wired up for a task, the CLI ` +
      `will return a clear error you can relay back.`,
    );
  } else {
    stableSections.push(
      `# Connected Infrastructure\n\n` +
      `Infrastructure access is provided via MCP tools when configured through Nexus.`,
    );
  }

  // Mode-specific instructions
  if (mode === 'heartbeat') {
    stableSections.push(getHeartbeatBaseInstructions(context.heartbeatMd));
    const heartbeatContext = getHeartbeatContextInstructions(context, slackMessages);
    if (heartbeatContext) {
      stableSections.push(heartbeatContext);
    }
  } else if (mode === 'cron') {
    stableSections.push(getCronInstructions());
  } else {
    stableSections.push(getChatInstructions());
  }

  // These are in addition to chat instructions, which are also relevant for subagents.
  if (mode === 'subagent') {
    stableSections.push(getSubagentInstructions());
  }

  // Recalled memories — auto-retrieved from memory_entries via embedding search.
  // Merged into the dynamic part to stay within Bedrock's 4 cache breakpoint limit.
  if (query) {
    const recalledMemories = await memoryManagerService.buildMemoryContext(
      context.userId,
      context.agentId,
      query,
    );
    if (recalledMemories) {
      dynamicSections.unshift(`# Recalled Memories\n\n${recalledMemories}`);
    }
  }

  // Runtime context — dynamic (timestamp changes every call)
  dynamicSections.push(`# Runtime Context\n\nCurrent UTC date and time (ISO-8601): ${new Date().toISOString()}`);

  const parts: SystemPromptPart[] = [];
  if (stableSections.length > 0) {
    parts.push({ text: stableSections.join('\n\n---\n\n'), cacheable: true });
  }
  if (dynamicSections.length > 0) {
    // When recalled memories are present, the dynamic part is safe to cache —
    // both memories and timestamp are constant within a multi-step generateText() call.
    const hasRecalledMemories = dynamicSections.some((s) => s.startsWith('# Recalled Memories'));
    parts.push({ text: dynamicSections.join('\n\n---\n\n'), cacheable: hasRecalledMemories });
  }
  return parts;
}

/**
 * Build system prompt from context (backward-compatible string form).
 */
export async function buildSystemPrompt(
  context: AgentContext,
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent' = 'chat',
  slackMessages?: SlackTriggerMessage[],
  query?: string,
): Promise<string> {
  const parts = await buildSystemPromptParts(context, mode, slackMessages, query);
  return parts.map((p) => p.text).join('\n\n---\n\n');
}

/**
 * Build conversation messages for LLM call.
 *
 * Returns AI SDK ModelMessage[] so tool call history is preserved as structured
 * assistant (tool-call) + tool (tool-result) message pairs.
 */
export function buildConversationMessages(context: AgentContext): ModelMessage[] {
  const messages: ModelMessage[] = [];

  // Add compaction summary as a user message with context marker
  if (context.conversationSummary) {
    messages.push({
      role: 'user',
      content: `[Previous conversation summary for context]\n${context.conversationSummary}`,
    });
    messages.push({
      role: 'assistant',
      content: 'I understand the previous conversation context. How can I help you now?',
    });
  }

  // Add recent messages (only user and assistant, skip system and empty messages)
  for (const msg of context.recentMessages) {
    if (msg.role === 'USER') {
      if (!msg.content?.trim()) continue;
      messages.push({ role: 'user', content: msg.content });
    } else if (msg.role === 'AGENT') {
      const toolCalls = parseToolCalls(msg);

      if (toolCalls.length > 0) {
        // Build assistant message with tool-call content blocks (+ text if present)
        const assistantParts: Array<{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }> = [];
        if (msg.content?.trim()) {
          assistantParts.push({ type: 'text', text: msg.content });
        }
        for (const tc of toolCalls) {
          assistantParts.push({
            type: 'tool-call',
            toolCallId: tc.id,
            toolName: tc.tool,
            input: tc.parsedInput,
          });
        }
        messages.push({ role: 'assistant', content: assistantParts } satisfies AssistantModelMessage);

        // Build tool message with tool-result content blocks
        const toolResultParts = toolCalls.map((tc) => ({
          type: 'tool-result' as const,
          toolCallId: tc.id,
          toolName: tc.tool,
          output: { type: 'text' as const, value: tc.output },
        }));
        messages.push({ role: 'tool', content: toolResultParts } satisfies ToolModelMessage);
      } else if (msg.content?.trim()) {
        // Plain text assistant message (no tool calls)
        messages.push({ role: 'assistant', content: msg.content });
      }
    }
  }

  return messages;
}

/**
 * Parse and validate tool calls from a conversation message.
 * Returns an empty array if toolCalls is missing, empty, or malformed.
 */
function parseToolCalls(msg: ConversationMessage): Array<{
  id: string;
  tool: string;
  parsedInput: unknown;
  output: string;
}> {
  if (!msg.toolCalls || !Array.isArray(msg.toolCalls) || msg.toolCalls.length === 0) {
    return [];
  }

  const results: Array<{ id: string; tool: string; parsedInput: unknown; output: string }> = [];

  for (let i = 0; i < msg.toolCalls.length; i++) {
    const tc = msg.toolCalls[i] as Record<string, unknown> | null | undefined;
    if (!tc || typeof tc.tool !== 'string' || !tc.tool) continue;

    let parsedInput: unknown = {};
    try {
      parsedInput = typeof tc.input === 'string' ? JSON.parse(tc.input) : (tc.input ?? {});
    } catch {
      parsedInput = {};
    }

    results.push({
      id: `${msg.id}-tc-${i}`,
      tool: tc.tool,
      parsedInput,
      output: typeof tc.output === 'string' ? tc.output : '',
    });
  }

  return results;
}

// ============================================================================
// Mode-Specific Instructions
// ============================================================================

function getChatInstructions(): string {
  return `# Chat Mode
You are in a conversation with your user. Respond naturally and helpfully.
You are an autonomous agent. Use your tools to take real action on behalf of the user.

## Core Principles

1. **Always use tools for real data** - Never guess about external state, memory, or schedules. Call the tool first.
2. **Store what you learn** - User preferences go in memory_write. Critical facts go in update_memory.
3. **Be proactive** - If user says "alert me when..." or "remind me to...", configure it immediately.
4. **Advance the vision** - When you see opportunities to help achieve the user's goals, take action.`;
}

/**
 * Heartbeat base instructions — stable across invocations.
 * Contains rules and configured checks (from heartbeatMd).
 */
function getHeartbeatBaseInstructions(heartbeatMd?: string): string {
  const sections = [
    `## Heartbeats`,
    ``,
    `You are performing a periodic heartbeat check. Your results might appear as messages in the user's conversation.`,
    ``,
    `### Rules`,
    `- Perform the configured checks and report your findings.`,
    `- Be productive. Use the heartbeat to advance the user's vision.`,
    `- Focus on NEW issues, CHANGES in status, and ACTIONABLE information.`,
    `- If everything looks normal, say so briefly (e.g. "All systems healthy").`,
    `- Do NOT repeat details the user has already seen unless the situation has changed.`,
  ];

  if (heartbeatMd) {
    sections.push('', `### Configured Checks`, heartbeatMd);
  }

  return sections.join('\n');
}

/**
 * Heartbeat dynamic instructions — changes per invocation.
 * Contains last alert context and Slack trigger messages.
 * Returns null when there's no dynamic content.
 */
function getHeartbeatContextInstructions(
  context: AgentContext,
  slackMessages?: SlackTriggerMessage[],
): string | null {
  const sections: string[] = [];

  if (context.lastHeartbeatAlert) {
    const ago = context.lastHeartbeatAlertAt
      ? formatTimeAgo(context.lastHeartbeatAlertAt)
      : 'recently';
    sections.push(
      `### Last Alert (${ago})`,
      context.lastHeartbeatAlert,
      ``,
      `The user already knows about the above. Only report on this topic if the situation has meaningfully changed.`,
    );
  }

  if (slackMessages && slackMessages.length > 0) {
    sections.push(`### Recent Slack Messages (triggering this heartbeat)`);
    sections.push('The following messages were posted in the monitored Slack channel since your last heartbeat:');
    sections.push('');
    for (const msg of slackMessages) {
      const ago = formatTimeAgo(new Date(msg.timestamp).getTime());
      sections.push(`- **${msg.sender}** (${ago}): "${msg.text}"`);
    }
    sections.push('');
    sections.push('Consider these messages as additional context for your heartbeat checks.');
  }

  return sections.length > 0 ? sections.join('\n') : null;
}

export function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}min ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function getCronInstructions(): string {
  return `# Scheduled Task Mode

You are executing a scheduled task. Follow the task instruction, report findings, and store important observations in memory.`;
}

function getSubagentInstructions(): string {
  return `# Subagent Mode

You are a subagent invoked by a parent agent. Your task is to execute the specific instruction given to you, report findings, and store important observations in memory. Stay focused on the specific task delegated by the parent agent.`;
}
