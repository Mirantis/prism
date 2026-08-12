/**
 * Context Builder (Prompt Assembly)
 *
 * Builds the system prompt and conversation messages from pre-fetched context.
 * No data fetching here — that stays in the backend's context-builder.service.ts.
 */

import { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
import { config } from '../config';
import { memoryManagerService } from '../services/memory-manager.service';
import {
  AttachmentForLLM,
  humanFileSize,
  isBedrockImageType,
} from '../services/attachment.service';
import { MAX_INLINE_TEXT_CHARS } from '../constants';
import { SlackTriggerMessage } from '../types';
import { skillCatalogService, type SkillSource } from '../services/skill-catalog.service';
import { pluginCatalogService } from '../services/plugin-catalog.service';
import { resolveSkillsDir, resolvePluginsDir } from '../lib/data-dir';

// Minimal type for conversation messages (matches Prisma's shape).
// toolCalls uses Prisma's Json? type (any JSON value); parseToolCalls() validates at runtime.
export interface ConversationMessage {
  id: string;
  role: 'USER' | 'AGENT' | 'SYSTEM';
  content: string;
  toolCalls?: unknown;
  // Provenance fields the compaction fork records so its commit can mark
  // exactly the rows that were in this context (Slack rows are watermarked by
  // ts, internal-step rows are flag-flipped). Optional because synthetic
  // messages don't carry them; real rows from the context service always do.
  externalMessageId?: string | null;
  internalStep?: boolean;
  // Files shared by the user (web upload or Slack attachment). Loaded with
  // bytes by the context service so they can be turned into LLM content parts.
  attachments?: AttachmentForLLM[];
}

/** AI SDK user-message content parts we emit (subset that works on Bedrock). */
type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; image: Buffer; mediaType: string }
  | { type: 'file'; data: Buffer; mediaType: string; filename: string };

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
  model: string | null;
  /** When false, only the final text step is delivered to the channel. */
  verbose: boolean;
  isBootstrapPhase: boolean;
  conversationSummary: string | null;
  recentMessages: ConversationMessage[];
  lastHeartbeatAlert?: string;
  lastHeartbeatAlertAt?: number;
  /** Per-turn runtime events to surface authoritatively (see InvokeRequest). */
  runtimeNotices?: string[];
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
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent' | 'goal' | 'webhook' | 'meeting' = 'chat',
  slackMessages?: SlackTriggerMessage[],
  query?: string,
  workspaceRoot?: string,
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

  // Containers run inside a Nexus sandbox where credentials + configs flow
  // into the local shell; the agent invokes CLIs via `shell_exec`.
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

  // Skills — Agent Skills (agentskills.io). Progressive disclosure: only name +
  // description go here so the model knows what's available; the `skill` tool
  // loads a skill's full instructions on demand. Includes the repo's workspace
  // skills when this turn has a workspaceRoot. Cacheable: stable within a thread
  // (a thread's workspaceRoot is fixed) and rescans only when a skills dir changes.
  stableSections.push(buildSkillsSection(workspaceRoot));

  // Plugins — Agent Plugins (agent-plugins.org). Deliberately not a second
  // skill listing: a plugin's skills already appear above, so this says only
  // which plugins are installed, what each contributed, and how a plugin's
  // tools are named — the one thing the tools block itself cannot convey.
  // Cacheable on the same terms as the skills section.
  stableSections.push(buildPluginsSection());

  // Concise delivery instructions (chat only, non-verbose)
  if (mode === 'chat' && !context.verbose) {
    stableSections.push(getConciseDeliveryInstructions());
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
  } else if (mode === 'webhook') {
    stableSections.push(getWebhookInstructions());
  } else if (mode === 'goal') {
    // Goal turns do real work like a chat turn, plus the autonomous-goal framing.
    stableSections.push(getChatInstructions());
    stableSections.push(getGoalInstructions());
  } else if (mode === 'meeting') {
    // No chat-mode section: a live voice meeting is not a conversation with the
    // user, and its delivery rules are the opposite of chat's (no markdown, no
    // paragraphs). `prompts/meeting-prompt.ts` is authoritative there and the
    // meeting service appends it.
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
  const now = new Date();
  const weekday = now.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  dynamicSections.push(`# Runtime Context\n\nCurrent UTC date and time (ISO-8601): ${now.toISOString()} (${weekday})`);

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
  // Per-turn runtime notices (e.g. an attachment that failed to download).
  // Authoritative system context — the model acts on these far more reliably
  // than the same text embedded in the user message. Never cacheable (changes
  // every turn) and kept as its own part so it doesn't consume a cache slot.
  if (context.runtimeNotices && context.runtimeNotices.length > 0) {
    const notice = [
      `# Runtime Notices`,
      ``,
      `These events occurred while preparing the current message. Treat them as authoritative facts and act on them in your reply:`,
      ``,
      ...context.runtimeNotices.map((n) => `- ${n}`),
    ].join('\n');
    parts.push({ text: notice, cacheable: false });
  }
  return parts;
}

/**
 * Build system prompt from context (backward-compatible string form).
 */
export async function buildSystemPrompt(
  context: AgentContext,
  mode: 'chat' | 'heartbeat' | 'cron' | 'subagent' | 'goal' | 'webhook' | 'meeting' = 'chat',
  slackMessages?: SlackTriggerMessage[],
  query?: string,
): Promise<string> {
  const parts = await buildSystemPromptParts(context, mode, slackMessages, query);
  return parts.map((p) => p.text).join('\n\n---\n\n');
}

/** Max skills listed inline before we summarize the overflow (a guardrail —
 * realistically the catalog is small). */
const MAX_SKILLS_LISTED = 50;

/** Same ceiling as skills: the listing is a map, not an inventory. */
const MAX_PLUGINS_LISTED = 50;

/**
 * Build the `# Skills` system-prompt section. Lists available skills (name +
 * one-line description — the `skill` tool loads a skill's full instructions on
 * demand) and tells the agent where skills live and how to add more. When the
 * turn has a `workspaceRoot`, the repo's own skills are listed first under a
 * labeled group. Always rendered so the agent can bootstrap its first skill too.
 */
function buildSkillsSection(workspaceRoot?: string): string {
  const skills = skillCatalogService.getCatalog(workspaceRoot);
  const skillsDir = resolveSkillsDir();

  // Where skills live + how to add more. Phrased around the canonical dir so
  // it's correct regardless of where an ecosystem installer fetches to — the
  // agent just needs the bundle to end up under `skillsDir`.
  const install =
    `Global skills are installed in \`${skillsDir}\` — each is a \`<name>/SKILL.md\` bundle ` +
    `(the agentskills.io standard, optionally with \`scripts/\`/\`references/\`/\`assets/\`). ` +
    `Repository skills come from the workspace's \`.claude/skills/\` or \`.agents/skills/\`. ` +
    `To add a global skill, use your shell tools to land a bundle there: copy or clone a ` +
    `\`SKILL.md\` folder into \`${skillsDir}/<name>/\`, or fetch one from the ecosystem ` +
    `with \`npx skills add <source> --copy\` (browse at https://skills.sh; \`<source>\` is a ` +
    `GitHub repo like \`owner/repo\`, a skill URL, or a local path) and copy the resulting ` +
    `\`<name>/\` folder into \`${skillsDir}\`. Newly added skills are detected automatically — ` +
    `no restart needed.`;

  if (skills.length === 0) {
    return `# Skills\n\nNo Agent Skills are available yet.\n\n${install}`;
  }

  // Group by source so the model (and the user) can see where each skill came
  // from. Driven off one ordered list rather than a bucket per source, so
  // adding a source can never silently drop its skills from the listing — or,
  // worse, leave them counted as overflow.
  const GROUPS: { source: SkillSource; heading: string }[] = [
    { source: 'workspace', heading: '**Workspace skills** (from this repository):' },
    { source: 'global', heading: '**Installed skills** (global):' },
    { source: 'plugin', heading: '**Plugin skills** (from installed plugins):' },
  ];
  const bullet = (s: { name: string; description: string }) => `- **${s.name}**: ${s.description}`;

  const buckets = GROUPS.map((g) => ({
    ...g,
    items: skills.filter((s) => s.source === g.source).slice(0, MAX_SKILLS_LISTED),
  })).filter((g) => g.items.length > 0);

  const overflow = skills.length - buckets.reduce((n, g) => n + g.items.length, 0);
  const groups = buckets.map((g) => {
    // A lone global list needs no heading — that's the default install, where
    // "where did this come from" has only one answer.
    const bare = buckets.length === 1 && g.source === 'global';
    return (bare ? '' : `${g.heading}\n`) + g.items.map(bullet).join('\n');
  });

  return (
    `# Skills\n\n` +
    `You have Agent Skills — specialized instruction sets for specific tasks. ` +
    `Each entry below is a name and a one-line description. When a task matches a skill, ` +
    `call the \`skill\` tool with its exact name to load the full instructions, then follow ` +
    `them. Don't guess a skill's contents from its description.\n\n` +
    groups.join('\n\n') +
    (overflow > 0
      ? `\n\n(+${overflow} more available — call \`skill\` with any listed skill's name to load it.)`
      : '') +
    `\n\n${install}`
  );
}

/**
 * The `# Plugins` section: which Agent Plugins are installed, what each one
 * contributed, and where plugins live so the agent can install one itself.
 *
 * Deliberately NOT a second skill listing — a plugin's skills are already in
 * `# Skills`, so repeating their descriptions here would pay for the same
 * tokens twice. What this adds that nothing else can:
 *
 *   - provenance: which plugin a given skill or tool came from;
 *   - the tool naming scheme, so `demo__probe__search` is legible as the
 *     `search` tool of the `probe` server in the `demo` plugin — the tools
 *     block carries the names but cannot explain them;
 *   - the install path, which is what makes "drop a folder in" reachable.
 *
 * When nothing is installed this collapses to a single sentence: most installs
 * have no plugins, and they should not pay for a section about a feature they
 * are not using beyond knowing it exists.
 */
function buildPluginsSection(): string {
  const pluginsDir = resolvePluginsDir();
  const plugins = pluginCatalogService.getPlugins();

  const install =
    `Plugins are installed in \`${pluginsDir}\` — each is a directory holding a ` +
    `\`plugin.json\` (the agent-plugins.org standard), plus an optional \`skills/\` ` +
    `and an optional \`mcp.json\` declaring MCP servers. To add one, use your shell ` +
    `tools to place a plugin directory there; to remove one, delete its directory. ` +
    `Changes are detected automatically — no restart needed.`;

  if (plugins.length === 0) {
    return `# Plugins\n\nNo Agent Plugins are installed. ${install}`;
  }

  const listed = plugins.slice(0, MAX_PLUGINS_LISTED);
  const overflow = plugins.length - listed.length;
  const skills = skillCatalogService.getCatalog();

  const lines = listed.map((p) => {
    // Only the skills this plugin actually contributed — one it shipped that
    // lost a name clash to a workspace or global skill is not available.
    const contributedSkills = skills.filter((s) => s.pluginId === p.id).map((s) => s.name);
    const parts: string[] = [];
    if (contributedSkills.length > 0) parts.push(`skills: ${contributedSkills.join(', ')}`);
    // Tool names are namespaced by plugin id, so the prefix is enough to point
    // at them without restating the whole tool list the tools block already has.
    if (p.mcpConfigPath) parts.push(`tools prefixed \`${p.id}__\``);
    const detail = parts.length > 0 ? ` (${parts.join('; ')})` : '';
    const version = p.version ? ` v${p.version}` : '';
    return `- **${p.id}**${version}${p.description ? ` — ${p.description}` : ''}${detail}`;
  });

  return (
    `# Plugins\n\n` +
    `These Agent Plugins are installed. Each can contribute skills (listed under ` +
    `# Skills above) and MCP tool servers (already in your tool set).\n\n` +
    lines.join('\n') +
    (overflow > 0 ? `\n\n(+${overflow} more installed.)` : '') +
    `\n\nA plugin's tools are named \`<plugin>__<server>__<tool>\`, so a tool called ` +
    `\`example__probe__search\` would be the \`search\` tool of the \`probe\` server in a ` +
    `plugin called \`example\`.\n\n${install}`
  );
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
      const parts = buildUserContentParts(msg);
      // Skip only when there's neither text nor any attachment.
      if (parts.length === 0) continue;
      // Keep the plain-string form when there's just text, rather than wrapping
      // every turn in a content array of one part.
      if (parts.length === 1 && parts[0].type === 'text') {
        messages.push({ role: 'user', content: parts[0].text });
      } else {
        messages.push({ role: 'user', content: parts });
      }
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
 * A message the user sent while a turn was already running, to be folded into
 * that turn at its next step boundary (see `threadTurnService`).
 */
export interface SteeringMessage {
  text: string;
  /** Files it carried, bytes already loaded. */
  attachments?: AttachmentForLLM[];
}

/**
 * Build the user turn for a mid-turn steering message.
 *
 * Goes through the same content-part construction as history, so a file shared
 * mid-turn is presented to the model exactly as one shared at the start of a
 * turn — same image/PDF handling, same inlining and truncation, same
 * "unreadable" note for types the provider would reject.
 */
export function buildSteeringMessage(msg: SteeringMessage): ModelMessage {
  const parts = buildUserContentParts({
    id: 'steering',
    role: 'USER',
    content: msg.text,
    attachments: msg.attachments,
  });

  // Keep the plain-string form when there's just text, same as history.
  if (parts.length === 1 && parts[0].type === 'text') {
    return { role: 'user', content: parts[0].text };
  }
  return { role: 'user', content: parts };
}

/**
 * Turn a USER message + its attachments into AI SDK content parts.
 *
 * Allowlist-driven on purpose: the Bedrock converter throws on an unknown
 * mediaType in an image/file part (killing the whole generateText call), so
 * only confidently-readable images and PDFs become image/file parts. Text/code
 * is inlined (truncated). Everything else becomes a plain "unreadable" note.
 */
function buildUserContentParts(msg: ConversationMessage): UserContentPart[] {
  const parts: UserContentPart[] = [];

  if (msg.content?.trim()) {
    parts.push({ type: 'text', text: msg.content });
  }

  for (const att of msg.attachments ?? []) {
    if (att.category === 'image' && isBedrockImageType(att.mediaType)) {
      parts.push({ type: 'image', image: att.data, mediaType: att.mediaType });
    } else if (att.category === 'pdf' && att.mediaType === 'application/pdf') {
      parts.push({ type: 'file', data: att.data, mediaType: 'application/pdf', filename: att.filename });
    } else if (att.category === 'text') {
      const raw = att.data.toString('utf8');
      const truncated = raw.length > MAX_INLINE_TEXT_CHARS;
      const body = truncated ? raw.slice(0, MAX_INLINE_TEXT_CHARS) : raw;
      const suffix = truncated
        ? `\n…[truncated — showing first ${MAX_INLINE_TEXT_CHARS} of ${raw.length} chars]`
        : '';
      parts.push({ type: 'text', text: `\n\n[File: ${att.filename}]\n\`\`\`\n${body}${suffix}\n\`\`\`` });
    } else {
      // Unreadable binary (or an image/pdf whose type isn't Bedrock-safe).
      parts.push({
        type: 'text',
        text: `[Attached file: ${att.filename} (${att.mediaType}, ${humanFileSize(att.sizeBytes)}) — not readable by the agent; stored and downloadable.]`,
      });
    }
  }

  return parts;
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
    `- If no checks are configured, reply with a brief all-clear (e.g. "All systems healthy"). Never comment on the heartbeat configuration itself (e.g. "no checks configured") — that is not a finding.`,
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

You are executing a scheduled task. Follow the task instruction, report findings, and store important observations in memory.

- If the instruction asks for output unconditionally (a report, summary, or reminder), always produce the requested output.
- If the instruction is conditional ("only tell me if...", "alert me when...") and the condition is not met, reply with a brief all-clear (e.g. "Nothing to report"). Never comment on the task or its configuration itself (e.g. "task ran, no action needed") — that is not a finding.
- Your final message is delivered automatically to the conversation or Slack channel this task reports into. Do NOT also post it yourself with Slack (or any other messaging) tools — that duplicates the message. A conditional task's brief all-clear is withheld rather than posted, so there is no need to pad it.

If this run is continuing an earlier conversation (its prior messages appear above), you are resuming after a wait you scheduled — respond as a natural continuation of that conversation, not as a standalone report. If what you were waiting for still hasn't happened, you may schedule another one-off task with continueInThread to check again later.`;
}

function getWebhookInstructions(): string {
  return `# Webhook Mode

You received an event pushed by an external system (e.g. Alertmanager, PagerDuty, GitHub) via an inbound webhook. The event payload and any subscription instructions are in the user message. Assess the event, take appropriate action with your tools per your configured guidance, and report your findings concisely. Store important observations in memory. If follow-up is needed later, you may schedule a one-off task to check again.`;
}

function getGoalInstructions(): string {
  return `# Goal Mode

You are autonomously pursuing a standing objective across multiple turns. The current
turn's objective and progress are in the user message. Each turn, make concrete,
verifiable progress using your tools rather than narrating or re-doing prior work. A
separate checker decides after each turn whether the objective is complete — you do not
need to declare completion with any tool; just do the work and state clearly when the
objective is fully met. If you become blocked, explain precisely what is blocking you.`;
}

function getSubagentInstructions(): string {
  return `# Subagent Mode

You are a subagent invoked by a parent agent. Your task is to execute the specific instruction given to you, report findings, and store important observations in memory. Stay focused on the specific task delegated by the parent agent.`;
}

function getConciseDeliveryInstructions(): string {
  return `# Response Delivery (Concise Mode)

Only your **final message** in a multi-step turn is delivered to the user. Intermediate text you produce while using tools is saved but not shown. Therefore your final message must be self-contained: state the outcome of the work you did, include any relevant results, and do not reference earlier narration the user cannot see, unless specifically asked by the user.`;
}

// Exported for unit tests: these sections read the filesystem, so asserting on
// them directly is cheaper and clearer than through a whole prompt build.
export const __test = { buildSkillsSection, buildPluginsSection };
