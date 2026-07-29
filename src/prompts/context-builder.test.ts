/**
 * Context Builder Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockBuildMemoryContext } = vi.hoisted(() => ({
  mockBuildMemoryContext: vi.fn(),
}));

vi.mock('../services/memory-manager.service', () => ({
  memoryManagerService: {
    buildMemoryContext: mockBuildMemoryContext,
  },
}));

import {
  buildSystemPrompt,
  buildSystemPromptParts,
  buildConversationMessages,
  buildSteeringMessage,
} from './context-builder';
import { createTestAgentContext } from '../test-utils/factories';
import type { AttachmentMeta } from '../services/attachment.service';

function makeAttachment(overrides: Partial<AttachmentMeta> = {}): AttachmentMeta {
  return {
    id: 'att-1',
    filename: 'file.bin',
    mediaType: 'application/octet-stream',
    category: 'unreadable',
    sizeBytes: 10,
    ...overrides,
  };
}

describe('buildSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildMemoryContext.mockResolvedValue('');
  });

  it('includes soul, user, and memory sections in all modes', async () => {
    const context = createTestAgentContext();

    for (const mode of ['chat', 'heartbeat', 'cron'] as const) {
      const prompt = await buildSystemPrompt(context, mode);
      expect(prompt).toContain('# Soul');
      expect(prompt).toContain(context.soulMd);
      expect(prompt).toContain('# User');
      expect(prompt).toContain(context.userMd);
      expect(prompt).toContain('# Memory');
      expect(prompt).toContain(context.memoryMd);
    }
  });

  it('adds bootstrap section in chat mode when isBootstrapPhase is true', async () => {
    const context = createTestAgentContext({ isBootstrapPhase: true });

    const chatPrompt = await buildSystemPrompt(context, 'chat');
    expect(chatPrompt).toContain('# Bootstrap Phase');
    expect(chatPrompt).toContain(context.bootstrapMd);

    // Bootstrap only applies to chat mode
    const heartbeatPrompt = await buildSystemPrompt(context, 'heartbeat');
    expect(heartbeatPrompt).not.toContain('# Bootstrap Phase');
  });

  it('includes vision section when visionMd is non-empty', async () => {
    const context = createTestAgentContext({ visionMd: 'Scale to 10k users by Q4.' });
    const prompt = await buildSystemPrompt(context, 'chat');
    expect(prompt).toContain('# Vision & Goals');
    expect(prompt).toContain('Scale to 10k users by Q4.');
  });

  it('omits vision section when visionMd is empty', async () => {
    const context = createTestAgentContext({ visionMd: '' });
    const prompt = await buildSystemPrompt(context, 'chat');
    expect(prompt).not.toContain('# Vision & Goals');
  });

  it('omits vision section when visionMd is whitespace only', async () => {
    const context = createTestAgentContext({ visionMd: '   ' });
    const prompt = await buildSystemPrompt(context, 'chat');
    expect(prompt).not.toContain('# Vision & Goals');
  });

  it('chat mode includes chat instructions', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'chat');
    expect(prompt).toContain('# Chat Mode');
  });

  it('heartbeat mode includes minimal heartbeat instructions (no HEARTBEAT_OK)', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'heartbeat');
    expect(prompt).toContain('## Heartbeats');
    expect(prompt).not.toContain('HEARTBEAT_OK');
    expect(prompt).not.toContain('THINK PHASE');
    expect(prompt).not.toContain('CHECK PHASE');
    expect(prompt).toContain('### Rules');
  });

  it('heartbeat mode includes configured checks', async () => {
    const context = createTestAgentContext({ heartbeatMd: 'Check for new items every 5 minutes.' });
    const prompt = await buildSystemPrompt(context, 'heartbeat');
    expect(prompt).toContain('### Configured Checks');
    expect(prompt).toContain('Check for new items every 5 minutes.');
  });

  it('heartbeat mode forbids commenting on the heartbeat configuration itself', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'heartbeat');
    expect(prompt).toContain('Never comment on the heartbeat configuration itself');
  });

  it('heartbeat mode injects last alert when present', async () => {
    const context = createTestAgentContext({
      lastHeartbeatAlert: 'Pod nginx-abc is CrashLoopBackOff',
      lastHeartbeatAlertAt: Date.now() - 30 * 60 * 1000, // 30 min ago
    });
    const prompt = await buildSystemPrompt(context, 'heartbeat');
    expect(prompt).toContain('### Last Alert');
    expect(prompt).toContain('30min ago');
    expect(prompt).toContain('Pod nginx-abc is CrashLoopBackOff');
    expect(prompt).toContain('meaningfully changed');
  });

  it('heartbeat mode omits last alert section when no prior alert', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'heartbeat');
    expect(prompt).not.toContain('### Last Alert');
  });

  it('heartbeat mode includes Slack messages section when slackMessages provided', async () => {
    const context = createTestAgentContext();
    const slackMessages = [
      { sender: 'Alice', text: 'deploy failed with OOM', timestamp: new Date().toISOString() },
      { sender: 'Bob', text: 'seeing increased error rates', timestamp: new Date().toISOString() },
    ];
    const prompt = await buildSystemPrompt(context, 'heartbeat', slackMessages);
    expect(prompt).toContain('### Recent Slack Messages (triggering this heartbeat)');
    expect(prompt).toContain('**Alice**');
    expect(prompt).toContain('deploy failed with OOM');
    expect(prompt).toContain('**Bob**');
    expect(prompt).toContain('seeing increased error rates');
  });

  it('heartbeat mode omits Slack messages section when slackMessages is empty', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'heartbeat', []);
    expect(prompt).not.toContain('Recent Slack Messages');
  });

  it('heartbeat mode omits Slack messages section when slackMessages is undefined', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'heartbeat', undefined);
    expect(prompt).not.toContain('Recent Slack Messages');
  });

  it('cron mode includes cron instructions', async () => {
    const context = createTestAgentContext();
    const prompt = await buildSystemPrompt(context, 'cron');
    expect(prompt).toContain('# Scheduled Task Mode');
  });

  it('webhook mode includes webhook instructions and no chat/bootstrap sections', async () => {
    const context = createTestAgentContext({ isBootstrapPhase: true });
    const prompt = await buildSystemPrompt(context, 'webhook');
    expect(prompt).toContain('# Webhook Mode');
    expect(prompt).toContain('inbound webhook');
    expect(prompt).not.toContain('# Bootstrap Phase');
    expect(prompt).not.toContain('# Scheduled Task Mode');
  });

  it('includes agent guide when agentMd is non-empty', async () => {
    const context = createTestAgentContext({ agentMd: 'Be proactive with heartbeats.' });
    const prompt = await buildSystemPrompt(context, 'chat');
    expect(prompt).toContain('# Agent Guide');
    expect(prompt).toContain('Be proactive with heartbeats.');
  });

  it('omits agent guide when agentMd is empty', async () => {
    const context = createTestAgentContext({ agentMd: '' });
    const prompt = await buildSystemPrompt(context, 'chat');
    expect(prompt).not.toContain('# Agent Guide');
  });
});

describe('buildSystemPromptParts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildMemoryContext.mockResolvedValue('');
  });

  it('returns stable and dynamic parts', async () => {
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat');

    expect(parts).toHaveLength(2);
    expect(parts[0].cacheable).toBe(true);
    expect(parts[1].cacheable).toBe(false);
  });

  it('stable part contains identity, soul, user, memory, attachments, and mode instructions', async () => {
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat');
    const stable = parts[0].text;

    expect(stable).toContain('# Identity');
    expect(stable).toContain(context.agentName);
    expect(stable).toContain('# Soul');
    expect(stable).toContain(context.soulMd);
    expect(stable).toContain('# User');
    expect(stable).toContain(context.userMd);
    expect(stable).toContain('# Memory');
    expect(stable).toContain(context.memoryMd);
    expect(stable).toContain('# Chat Mode');
    expect(stable).toContain('# Connected Infrastructure');
    expect(stable).toContain('## Attachments');
    expect(stable).toContain('hydrate_attachment');
    expect(stable).toContain('view_attachment');
    expect(stable).toContain('untrusted DATA');
  });

  it('dynamic part contains runtime context timestamp', async () => {
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat');
    const dynamic = parts[1].text;

    expect(dynamic).toContain('# Runtime Context');
    expect(dynamic).toMatch(/\d{4}-\d{2}-\d{2}T/);
    // Includes the weekday name to prevent the model miscalculating the day of week.
    expect(dynamic).toMatch(/\((Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\)/);
  });

  it('stable part does NOT contain runtime context timestamp', async () => {
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat');
    const stable = parts[0].text;

    expect(stable).not.toContain('# Runtime Context');
  });

  it('puts bootstrap phase in dynamic part', async () => {
    const context = createTestAgentContext({ isBootstrapPhase: true, bootstrapMd: 'Welcome!' });
    const parts = await buildSystemPromptParts(context, 'chat');
    const dynamic = parts.find((p) => p.text.includes('Bootstrap'))!;

    expect(dynamic.text).toContain('# Bootstrap Phase');
    expect(dynamic.text).toContain('Welcome!');
  });

  it('heartbeat mode puts rules and checks in stable part', async () => {
    const context = createTestAgentContext({ heartbeatMd: 'Check items.' });
    const parts = await buildSystemPromptParts(context, 'heartbeat');
    const stable = parts.find((p) => p.cacheable)!;

    expect(stable.text).toContain('## Heartbeats');
    expect(stable.text).toContain('### Rules');
    expect(stable.text).toContain('### Configured Checks');
    expect(stable.text).toContain('Check items.');
  });

  it('heartbeat mode puts last alert in stable part', async () => {
    const context = createTestAgentContext({
      lastHeartbeatAlert: 'Pod crashed',
      lastHeartbeatAlertAt: Date.now() - 30 * 60 * 1000,
    });
    const parts = await buildSystemPromptParts(context, 'heartbeat');
    const stable = parts.find((p) => p.cacheable)!;

    expect(stable.text).toContain('### Last Alert');
    expect(stable.text).toContain('Pod crashed');
  });

  it('heartbeat mode puts Slack messages in stable part', async () => {
    const context = createTestAgentContext();
    const slackMessages = [
      { sender: 'Alice', text: 'deploy failed', timestamp: new Date().toISOString() },
    ];
    const parts = await buildSystemPromptParts(context, 'heartbeat', slackMessages);
    const stable = parts.find((p) => p.cacheable)!;

    expect(stable.text).toContain('### Recent Slack Messages');
    expect(stable.text).toContain('Alice');
  });

  it('backward-compatible buildSystemPrompt joins all parts', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const context = createTestAgentContext();
      const parts = await buildSystemPromptParts(context, 'chat');
      const joined = await buildSystemPrompt(context, 'chat');

      expect(joined).toBe(parts.map((p) => p.text).join('\n\n---\n\n'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('includes recalled memories in dynamic part when query provided', async () => {
    mockBuildMemoryContext.mockResolvedValue('## Observations\n- Mario enjoys humor');
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat', undefined, 'what do I enjoy?');
    const dynamic = parts[1].text;

    expect(dynamic).toContain('# Recalled Memories');
    expect(dynamic).toContain('Mario enjoys humor');
    expect(dynamic).toContain('# Runtime Context');
  });

  it('marks dynamic part as cacheable when recalled memories present', async () => {
    mockBuildMemoryContext.mockResolvedValue('## Observations\n- Some memory');
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat', undefined, 'test query');

    expect(parts[1].cacheable).toBe(true);
  });

  it('keeps dynamic part non-cacheable when no recalled memories', async () => {
    mockBuildMemoryContext.mockResolvedValue('');
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat', undefined, 'test query');

    expect(parts[1].cacheable).toBe(false);
  });

  it('does not call buildMemoryContext when no query provided', async () => {
    const context = createTestAgentContext();
    await buildSystemPromptParts(context, 'chat');

    expect(mockBuildMemoryContext).not.toHaveBeenCalled();
  });

  it('injects runtime notices as a non-cacheable system part', async () => {
    const context = createTestAgentContext({
      runtimeNotices: ['A file could not be downloaded — the Slack app likely needs the files:read scope.'],
    });
    const parts = await buildSystemPromptParts(context, 'chat');

    const noticePart = parts.find((p) => p.text.includes('# Runtime Notices'));
    expect(noticePart).toBeDefined();
    expect(noticePart!.cacheable).toBe(false);
    expect(noticePart!.text).toContain('authoritative');
    expect(noticePart!.text).toContain('files:read');
  });

  it('omits the runtime notices section when there are none', async () => {
    const context = createTestAgentContext();
    const parts = await buildSystemPromptParts(context, 'chat');
    expect(parts.some((p) => p.text.includes('# Runtime Notices'))).toBe(false);
  });
});

describe('buildConversationMessages', () => {
  it('returns empty array when context has no messages and no summary', () => {
    const context = createTestAgentContext({
      conversationSummary: null,
      recentMessages: [],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toEqual([]);
  });

  it('adds conversation summary as user + assistant message pair', () => {
    const context = createTestAgentContext({
      conversationSummary: 'Discussed pod scaling.',
      recentMessages: [],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toContain('Discussed pod scaling.');
    expect(messages[1].role).toBe('assistant');
  });

  it('filters out SYSTEM role messages', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'SYSTEM', content: 'system msg' },
        { id: '2', role: 'USER', content: 'hello' },
        { id: '3', role: 'AGENT', content: 'hi there' },
      ],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toHaveLength(2);
    expect(messages.find((m) => m.content === 'system msg')).toBeUndefined();
  });

  it('maps USER to user and AGENT to assistant (plain text)', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'USER', content: 'hello' },
        { id: '2', role: 'AGENT', content: 'hi' },
      ],
    });
    const messages = buildConversationMessages(context);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'hi' });
  });

  it('emits assistant tool-call + tool result messages for AGENT with toolCalls', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'USER', content: 'list pods' },
        {
          id: 'msg-abc',
          role: 'AGENT',
          content: 'Let me check.',
          toolCalls: [
            { tool: 'list_pods', input: '{"namespace":"default"}', output: '["pod-1","pod-2"]', success: true, timestamp: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    });
    const messages = buildConversationMessages(context);

    // user + assistant (with tool-call) + tool (with tool-result) = 3 messages
    expect(messages).toHaveLength(3);

    // First: user message
    expect(messages[0]).toEqual({ role: 'user', content: 'list pods' });

    // Second: assistant with text + tool-call parts
    expect(messages[1].role).toBe('assistant');
    const assistantContent = messages[1].content as unknown[];
    expect(assistantContent).toHaveLength(2);
    expect(assistantContent[0]).toEqual({ type: 'text', text: 'Let me check.' });
    expect(assistantContent[1]).toEqual({
      type: 'tool-call',
      toolCallId: 'msg-abc-tc-0',
      toolName: 'list_pods',
      input: { namespace: 'default' },
    });

    // Third: tool message with tool-result
    expect(messages[2].role).toBe('tool');
    const toolContent = messages[2].content as unknown[];
    expect(toolContent).toHaveLength(1);
    expect(toolContent[0]).toEqual({
      type: 'tool-result',
      toolCallId: 'msg-abc-tc-0',
      toolName: 'list_pods',
      output: { type: 'text', value: '["pod-1","pod-2"]' },
    });
  });

  it('emits tool-call without text when AGENT content is empty', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: 'msg-1',
          role: 'AGENT',
          content: '',
          toolCalls: [
            { tool: 'get_status', input: '{}', output: '"ok"', success: true, timestamp: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    });
    const messages = buildConversationMessages(context);

    expect(messages).toHaveLength(2);
    // Assistant content should only have the tool-call, no text part
    const assistantContent = messages[0].content as unknown[];
    expect(assistantContent).toHaveLength(1);
    expect(assistantContent[0]).toEqual(expect.objectContaining({ type: 'tool-call' }));
  });

  it('handles multiple tool calls in a single message', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: 'msg-multi',
          role: 'AGENT',
          content: 'Checking everything.',
          toolCalls: [
            { tool: 'list_pods', input: '{}', output: '["pod-1"]', success: true, timestamp: '2026-01-01T00:00:00Z' },
            { tool: 'get_cluster', input: '{"id":"c1"}', output: '{"name":"prod"}', success: true, timestamp: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    });
    const messages = buildConversationMessages(context);

    expect(messages).toHaveLength(2);

    const assistantContent = messages[0].content as unknown[];
    expect(assistantContent).toHaveLength(3); // text + 2 tool-calls
    expect(assistantContent[1]).toEqual(expect.objectContaining({ toolCallId: 'msg-multi-tc-0', toolName: 'list_pods' }));
    expect(assistantContent[2]).toEqual(expect.objectContaining({ toolCallId: 'msg-multi-tc-1', toolName: 'get_cluster' }));

    const toolContent = messages[1].content as unknown[];
    expect(toolContent).toHaveLength(2);
    expect(toolContent[0]).toEqual(expect.objectContaining({ toolCallId: 'msg-multi-tc-0' }));
    expect(toolContent[1]).toEqual(expect.objectContaining({ toolCallId: 'msg-multi-tc-1' }));
  });

  it('treats null toolCalls as plain text message', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'AGENT', content: 'just text', toolCalls: null },
      ],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'just text' });
  });

  it('treats empty toolCalls array as plain text message', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'AGENT', content: 'just text', toolCalls: [] },
      ],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toEqual({ role: 'assistant', content: 'just text' });
  });

  it('handles malformed input JSON gracefully (defaults to empty object)', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: 'msg-bad',
          role: 'AGENT',
          content: '',
          toolCalls: [
            { tool: 'broken_tool', input: '{not valid json', output: 'some output', success: false, timestamp: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    });
    const messages = buildConversationMessages(context);

    expect(messages).toHaveLength(2);
    const assistantContent = messages[0].content as unknown[];
    expect(assistantContent[0]).toEqual(expect.objectContaining({
      type: 'tool-call',
      toolName: 'broken_tool',
      input: {},
    }));
  });

  it('skips tool call entries with missing tool name', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: 'msg-skip',
          role: 'AGENT',
          content: 'response',
          toolCalls: [
            // Valid
            { tool: 'good_tool', input: '{}', output: 'ok', success: true, timestamp: '2026-01-01T00:00:00Z' },
            // Missing tool name — should be skipped
            { tool: '', input: '{}', output: '', success: false, timestamp: '' } as any,
          ],
        },
      ],
    });
    const messages = buildConversationMessages(context);

    // Should still emit tool-call message (1 valid tool call)
    expect(messages).toHaveLength(2);
    const assistantContent = messages[0].content as unknown[];
    // text + 1 tool-call (the invalid one is skipped)
    const toolCallParts = (assistantContent as Array<{ type: string }>).filter(p => p.type === 'tool-call');
    expect(toolCallParts).toHaveLength(1);
  });

  it('handles empty tool output', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: 'msg-empty',
          role: 'AGENT',
          content: '',
          toolCalls: [
            { tool: 'fire_and_forget', input: '{}', output: '', success: true, timestamp: '2026-01-01T00:00:00Z' },
          ],
        },
      ],
    });
    const messages = buildConversationMessages(context);

    const toolContent = messages[1].content as unknown[];
    expect(toolContent[0]).toEqual(expect.objectContaining({
      output: { type: 'text', value: '' },
    }));
  });

  it('mixed messages: some with tool calls, some without', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'USER', content: 'hello' },
        { id: '2', role: 'AGENT', content: 'hi there' },
        { id: '3', role: 'USER', content: 'list pods' },
        {
          id: '4',
          role: 'AGENT',
          content: 'Checking...',
          toolCalls: [
            { tool: 'list_pods', input: '{}', output: '["pod-1"]', success: true, timestamp: '2026-01-01T00:00:00Z' },
          ],
        },
        { id: '5', role: 'USER', content: 'thanks' },
        { id: '6', role: 'AGENT', content: 'You are welcome!' },
      ],
    });
    const messages = buildConversationMessages(context);

    // user, assistant, user, assistant(tool-call), tool(result), user, assistant
    expect(messages).toHaveLength(7);
    expect(messages[0]).toEqual({ role: 'user', content: 'hello' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'hi there' });
    expect(messages[2]).toEqual({ role: 'user', content: 'list pods' });
    expect(messages[3].role).toBe('assistant');
    expect(Array.isArray(messages[3].content)).toBe(true);
    expect(messages[4].role).toBe('tool');
    expect(messages[5]).toEqual({ role: 'user', content: 'thanks' });
    expect(messages[6]).toEqual({ role: 'assistant', content: 'You are welcome!' });
  });

  it('skips AGENT messages with no content and no tool calls', () => {
    const context = createTestAgentContext({
      recentMessages: [
        { id: '1', role: 'AGENT', content: '   ', toolCalls: null },
      ],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toHaveLength(0);
  });
});

describe('buildConversationMessages with attachments (metadata stubs)', () => {
  const textOf = (content: unknown): string =>
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.map((p) => (p as { text?: string }).text ?? '').join('')
        : '';

  it('keeps plain-string form for a text-only USER message (no attachments)', () => {
    const context = createTestAgentContext({
      recentMessages: [{ id: '1', role: 'USER', content: 'hi' }],
    });
    const messages = buildConversationMessages(context);
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' });
  });

  it('emits a text metadata stub (not an image part) for an image attachment', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: '1',
          role: 'USER',
          content: 'what is this?',
          attachments: [makeAttachment({ id: 'a', filename: 'pic.png', mediaType: 'image/png', category: 'image', sizeBytes: 3 })],
        },
      ],
    });
    const messages = buildConversationMessages(context);
    const content = messages[0].content as unknown[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'text', text: 'what is this?' });
    // Metadata stub — no image bytes
    expect((content[1] as { type: string }).type).toBe('text');
    const stub = (content[1] as { text: string }).text;
    expect(stub).toContain('pic.png');
    expect(stub).toContain('id=a');
    expect(stub).toContain('image/png');
    expect(stub).toContain('hydrate_attachment');
  });

  it('emits a text metadata stub (not a file part) for a PDF attachment', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: '1',
          role: 'USER',
          content: '',
          attachments: [makeAttachment({ id: 'a', filename: 'doc.pdf', mediaType: 'application/pdf', category: 'pdf', sizeBytes: 5000 })],
        },
      ],
    });
    const messages = buildConversationMessages(context);
    const text = textOf(messages[0].content);
    expect(text).toContain('doc.pdf');
    expect(text).toContain('id=a');
    expect(text).toContain('application/pdf');
    expect(text).toContain('hydrate_attachment');
    expect(text).not.toContain('[object');
  });

  it('renders a metadata stub for text attachments (no inline content)', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: '1',
          role: 'USER',
          content: '',
          attachments: [makeAttachment({ id: 'a', filename: 'notes.txt', mediaType: 'text/plain', category: 'text', sizeBytes: 42 })],
        },
      ],
    });
    const messages = buildConversationMessages(context);
    const text = textOf(messages[0].content);
    expect(text).toContain('notes.txt');
    expect(text).toContain('id=a');
    expect(text).toContain('text/plain');
    expect(text).toContain('42 B');
  });

  it('renders a metadata stub for unreadable binaries', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: '1',
          role: 'USER',
          content: '',
          attachments: [makeAttachment({ id: 'a', filename: 'archive.zip', mediaType: 'application/zip', category: 'unreadable', sizeBytes: 2048 })],
        },
      ],
    });
    const messages = buildConversationMessages(context);
    const text = textOf(messages[0].content);
    expect(text).toContain('archive.zip');
    expect(text).toContain('id=a');
    expect(text).toContain('2.0 KB');
  });

  it('does not skip a file-only USER message (empty content + attachment)', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: '1',
          role: 'USER',
          content: '',
          attachments: [makeAttachment({ id: 'a', filename: 'pic.png', mediaType: 'image/png', category: 'image', sizeBytes: 100 })],
        },
      ],
    });
    const messages = buildConversationMessages(context);
    expect(messages).toHaveLength(1);
    // With only text parts and a single stub, it collapses to plain string.
    const text = textOf(messages[0].content);
    expect(text).toContain('pic.png');
    expect(text).toContain('hydrate_attachment');
  });

  it('includes human-readable size in the stub', () => {
    const context = createTestAgentContext({
      recentMessages: [
        {
          id: '1',
          role: 'USER',
          content: 'check this',
          attachments: [makeAttachment({ id: 'b', filename: 'data.csv', mediaType: 'text/csv', category: 'text', sizeBytes: 1536 })],
        },
      ],
    });
    const messages = buildConversationMessages(context);
    const text = textOf(messages[0].content);
    expect(text).toContain('1.5 KB');
  });
});

describe('buildSteeringMessage', () => {
  it('is a plain-string user turn when there is only text', () => {
    // Same reasoning as history: no needless content array around bare text.
    expect(buildSteeringMessage({ text: 'skip the tests' })).toEqual({
      role: 'user',
      content: 'skip the tests',
    });
  });

  it('carries an image shared mid-turn as a metadata stub, not image bytes', () => {
    const message = buildSteeringMessage({
      text: 'look at this',
      attachments: [
        makeAttachment({ id: 'a', filename: 'shot.png', mediaType: 'image/png', category: 'image' }),
      ],
    });

    expect(message.role).toBe('user');
    const content = message.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: 'text', text: 'look at this' });
    // Same hydrate-first treatment as a file shared at the start of a turn.
    expect(content[1].type).toBe('text');
    expect(content[1].text).toContain('shot.png');
    expect(content[1].text).toContain('id=a');
    expect(content[1].text).toContain('view_attachment');
  });

  it('stubs a text file shared mid-turn instead of inlining it', () => {
    const message = buildSteeringMessage({
      text: 'here is the failure',
      attachments: [
        makeAttachment({
          id: 'b',
          filename: 'run.log',
          mediaType: 'text/plain',
          category: 'text',
          sizeBytes: 42,
        }),
      ],
    });

    const content = message.content as Array<{ type: string; text?: string }>;
    expect(content[0]).toEqual({ type: 'text', text: 'here is the failure' });
    expect(content[1].text).toContain('run.log');
    expect(content[1].text).toContain('id=b');
    expect(content[1].text).toContain('hydrate_attachment');
  });

  it('stubs a binary file rather than dropping it', () => {
    const message = buildSteeringMessage({
      text: 'and this one',
      attachments: [makeAttachment({ filename: 'weird.bin' })],
    });

    const content = message.content as Array<{ type: string; text?: string }>;
    expect(content[1].text).toContain('weird.bin');
    expect(content[1].text).toContain('hydrate_attachment');
  });

  it('is a file-only turn when the message carried no text', () => {
    const message = buildSteeringMessage({
      text: '',
      attachments: [
        makeAttachment({ id: 'c', filename: 'doc.pdf', mediaType: 'application/pdf', category: 'pdf' }),
      ],
    });

    // A single stub part collapses to the plain-string form, same as history.
    expect(typeof message.content).toBe('string');
    expect(message.content as string).toContain('doc.pdf');
    expect(message.content as string).toContain('id=c');
  });
});
