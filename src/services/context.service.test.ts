/**
 * Context Service Tests
 *
 * Tests for ContextService: agent lookup, bootstrap detection,
 * active thread resolution, conversation inclusion, message filtering/slicing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AgentWorkspace } from '@prisma/client';
import type { ConversationMessage } from '../prompts/context-builder';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockGetAgent,
  mockGetLatestThread,
  mockGetThreadContext,
  mockGetMetaByMessageIds,
  mockGetMetaByExternalTs,
  mockLoadForMessages,
  mockLoadByExternalTs,
} = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockGetLatestThread: vi.fn(),
  mockGetThreadContext: vi.fn(),
  mockGetMetaByMessageIds: vi.fn(),
  mockGetMetaByExternalTs: vi.fn(),
  mockLoadForMessages: vi.fn(),
  mockLoadByExternalTs: vi.fn(),
}));

vi.mock('./agent-workspace.service', () => ({
  agentWorkspaceService: {
    getAgent: mockGetAgent,
  },
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    getLatestThread: mockGetLatestThread,
    getThreadContext: mockGetThreadContext,
  },
}));

vi.mock('./attachment.service', () => ({
  attachmentService: {
    getMetaByMessageIds: mockGetMetaByMessageIds,
    getMetaByExternalTs: mockGetMetaByExternalTs,
    loadForMessages: mockLoadForMessages,
    loadByExternalTs: mockLoadByExternalTs,
  },
}));

// ---------------------------------------------------------------------------
// Import under test
// ---------------------------------------------------------------------------

import { contextService } from './context.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestAgentWorkspace(overrides?: Partial<AgentWorkspace>): Partial<AgentWorkspace> {
  return {
    id: 'agent-1',
    userId: 'user-1',
    name: 'Test Agent',
    soulMd: 'soul content',
    userMd: 'user content',
    memoryMd: 'memory content',
    heartbeatMd: 'heartbeat content',
    bootstrapMd: '',
    visionMd: 'vision content',
    agentMd: 'agent guide',
    heartbeatIntervalMs: 28800000,
    heartbeatStatus: 'ENABLED',
    timezone: 'UTC',
    status: 'IDLE',
    ...overrides,
  };
}

function createTestMessage(overrides?: Partial<ConversationMessage>): ConversationMessage {
  return {
    id: 'msg-1',
    role: 'USER',
    content: 'Hello',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ContextService', () => {
  beforeEach(() => {
    mockGetAgent.mockReset();
    mockGetLatestThread.mockReset();
    mockGetThreadContext.mockReset();
    // Default: no attachments anywhere (empty maps).
    mockGetMetaByMessageIds.mockReset().mockResolvedValue(new Map());
    mockGetMetaByExternalTs.mockReset().mockResolvedValue(new Map());
    mockLoadForMessages.mockReset().mockResolvedValue(new Map());
    mockLoadByExternalTs.mockReset().mockResolvedValue(new Map());
  });

  // ==========================================================================
  // Agent lookup and field mapping
  // ==========================================================================

  it('maps agent fields into AgentContext', async () => {
    const agent = createTestAgentWorkspace();
    mockGetAgent.mockResolvedValue(agent);

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: false,
    });

    expect(mockGetAgent).toHaveBeenCalled();
    expect(context.soulMd).toBe('soul content');
    expect(context.userMd).toBe('user content');
    expect(context.memoryMd).toBe('memory content');
    expect(context.heartbeatMd).toBe('heartbeat content');
    expect(context.bootstrapMd).toBe('');
    expect(context.visionMd).toBe('vision content');
    expect(context.agentMd).toBe('agent guide');
    expect(context.agentName).toBe('Test Agent');
    expect(context.agentId).toBe('agent-1');
    expect(context.userId).toBe('user-1');
  });

  // ==========================================================================
  // Bootstrap detection
  // ==========================================================================

  it('sets isBootstrapPhase=true when bootstrapMd has content', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace({ bootstrapMd: 'Welcome!' }));

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: false,
    });

    expect(context.isBootstrapPhase).toBe(true);
  });

  it('sets isBootstrapPhase=false when bootstrapMd is empty', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace({ bootstrapMd: '' }));

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: false,
    });

    expect(context.isBootstrapPhase).toBe(false);
  });

  it('sets isBootstrapPhase=false when bootstrapMd is whitespace-only', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace({ bootstrapMd: '   \n  ' }));

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: false,
    });

    expect(context.isBootstrapPhase).toBe(false);
  });

  // ==========================================================================
  // Conversation inclusion
  // ==========================================================================

  it('skips conversation when includeConversation is false', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: false,
    });

    expect(mockGetLatestThread).not.toHaveBeenCalled();
    expect(mockGetThreadContext).not.toHaveBeenCalled();
    expect(context.conversationSummary).toBeNull();
    expect(context.recentMessages).toEqual([]);
  });

  it('fetches conversation when threadId is provided', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: 'Previous discussion about pods',
      messages: [createTestMessage({ content: 'What pods are running?' })],
    });

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      threadId: 'thread-1',
      includeConversation: true,
    });

    expect(mockGetLatestThread).not.toHaveBeenCalled();
    expect(mockGetThreadContext).toHaveBeenCalledWith('thread-1');
    expect(context.conversationSummary).toBe('Previous discussion about pods');
    expect(context.recentMessages).toHaveLength(1);
  });

  // ==========================================================================
  // Active thread resolution
  // ==========================================================================

  it('auto-resolves active thread when includeConversation is true but no threadId', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetLatestThread.mockResolvedValue({ id: 'active-thread-1' });
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages: [createTestMessage()],
    });

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: true,
    });

    expect(mockGetLatestThread).toHaveBeenCalledWith('user-1');
    expect(mockGetThreadContext).toHaveBeenCalledWith('active-thread-1');
    expect(context.recentMessages).toHaveLength(1);
  });

  it('returns empty conversation when no active thread exists', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetLatestThread.mockResolvedValue(null);

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: true,
    });

    expect(mockGetLatestThread).toHaveBeenCalledWith('user-1');
    expect(mockGetThreadContext).not.toHaveBeenCalled();
    expect(context.conversationSummary).toBeNull();
    expect(context.recentMessages).toEqual([]);
  });

  // ==========================================================================
  // includeConversation defaults to true
  // ==========================================================================

  it('defaults includeConversation to true', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetLatestThread.mockResolvedValue({ id: 'thread-1' });
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages: [createTestMessage()],
    });

    await contextService.getAgentContext('user-1', { agentId: 'agent-1' });

    expect(mockGetLatestThread).toHaveBeenCalled();
    expect(mockGetThreadContext).toHaveBeenCalled();
  });

  // ==========================================================================
  // Message filtering and slicing
  // ==========================================================================

  it('filters out empty and whitespace-only messages', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages: [
        createTestMessage({ id: 'msg-1', content: 'Hello' }),
        createTestMessage({ id: 'msg-2', content: '' }),
        createTestMessage({ id: 'msg-3', content: '   ' }),
        createTestMessage({ id: 'msg-4', content: '\n' }),
        createTestMessage({ id: 'msg-5', content: 'World' }),
      ],
    });

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      threadId: 'thread-1',
    });

    expect(context.recentMessages).toHaveLength(2);
    expect(context.recentMessages[0].content).toBe('Hello');
    expect(context.recentMessages[1].content).toBe('World');
  });

  it('preserves AGENT messages with empty content but valid toolCalls', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages: [
        createTestMessage({ id: 'msg-1', role: 'USER', content: 'list pods' }),
        createTestMessage({
          id: 'msg-2',
          role: 'AGENT',
          content: '',
          toolCalls: [{ tool: 'list_pods', input: '{}', output: '["pod-1"]', success: true, timestamp: '2026-01-01T00:00:00Z' }],
        } as any),
        createTestMessage({ id: 'msg-3', role: 'USER', content: 'thanks' }),
      ],
    });

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      threadId: 'thread-1',
    });

    expect(context.recentMessages).toHaveLength(3);
    expect(context.recentMessages[1].id).toBe('msg-2');
  });

  it('attaches metadata (no bytes) onto messages and keeps a file-only message in the window', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      threadSource: 'DATABASE',
      messages: [
        createTestMessage({ id: 'msg-1', role: 'USER', content: 'here is a file' }),
        // File-only: empty content, no toolCalls — kept only because it has an attachment.
        createTestMessage({ id: 'msg-2', role: 'USER', content: '' }),
      ],
    });
    const meta = { id: 'a1', filename: 'pic.png', mediaType: 'image/png', category: 'image', sizeBytes: 3 };
    mockGetMetaByMessageIds.mockResolvedValue(new Map([['msg-2', [meta]]]));

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      threadId: 'thread-1',
    });

    // msg-2 survives the empty-content filter because it carries an attachment.
    expect(context.recentMessages).toHaveLength(2);
    const fileOnly = context.recentMessages.find((m) => m.id === 'msg-2')!;
    expect(fileOnly.attachments).toEqual([meta]);
    // BLOB-loading functions should NOT be called — only metadata.
    expect(mockLoadForMessages).not.toHaveBeenCalled();
    expect(mockLoadByExternalTs).not.toHaveBeenCalled();
  });

  it('re-associates Slack channel attachments by external ts (metadata only, no bytes)', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      threadSource: 'SLACK',
      messages: [
        // SlackThreadProvider synthesizes ids and sets externalMessageId = ts.
        createTestMessage({ id: 'synthetic-1', role: 'USER', content: 'see file', externalMessageId: '1700.0001' } as any),
      ],
    });
    const meta = { id: 'a1', filename: 'doc.pdf', mediaType: 'application/pdf', category: 'pdf', sizeBytes: 9 };
    mockGetMetaByExternalTs.mockResolvedValue(new Map([['1700.0001', [meta]]]));

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      threadId: 'thread-slack',
    });

    // Only metadata queries are used — no BLOB loading.
    expect(mockLoadByExternalTs).not.toHaveBeenCalled();
    expect(mockLoadForMessages).not.toHaveBeenCalled();
    expect(context.recentMessages[0].attachments).toEqual([meta]);
  });

  it('keeps every non-compacted message — no count window', async () => {
    // The old last-20 slice is gone: compaction (compaction.service.ts) bounds
    // the context in steady state, and everything the provider returned (it
    // already filters compacted rows) reaches the model.
    const messages = Array.from({ length: 25 }, (_, i) =>
      createTestMessage({ id: `msg-${i}`, content: `Message ${i}` })
    );

    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages,
    });

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      threadId: 'thread-1',
    });

    expect(context.recentMessages).toHaveLength(25);
    expect(context.recentMessages[0].content).toBe('Message 0');
    expect(context.recentMessages[24].content).toBe('Message 24');
  });
});
