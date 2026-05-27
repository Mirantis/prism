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

const { mockGetAgent, mockGetActiveThread, mockGetThreadContext } = vi.hoisted(() => ({
  mockGetAgent: vi.fn(),
  mockGetActiveThread: vi.fn(),
  mockGetThreadContext: vi.fn(),
}));

vi.mock('./agent-workspace.service', () => ({
  agentWorkspaceService: {
    getAgent: mockGetAgent,
  },
}));

vi.mock('./conversation.service', () => ({
  conversationService: {
    getActiveThread: mockGetActiveThread,
    getThreadContext: mockGetThreadContext,
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
    proactivity: 3,
    verbosity: 3,
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
    mockGetActiveThread.mockReset();
    mockGetThreadContext.mockReset();
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
    expect(context.proactivity).toBe(3);
    expect(context.verbosity).toBe(3);
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

    expect(mockGetActiveThread).not.toHaveBeenCalled();
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

    expect(mockGetActiveThread).not.toHaveBeenCalled();
    expect(mockGetThreadContext).toHaveBeenCalledWith('thread-1');
    expect(context.conversationSummary).toBe('Previous discussion about pods');
    expect(context.recentMessages).toHaveLength(1);
  });

  // ==========================================================================
  // Active thread resolution
  // ==========================================================================

  it('auto-resolves active thread when includeConversation is true but no threadId', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetActiveThread.mockResolvedValue({ id: 'active-thread-1' });
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages: [createTestMessage()],
    });

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: true,
    });

    expect(mockGetActiveThread).toHaveBeenCalledWith('user-1');
    expect(mockGetThreadContext).toHaveBeenCalledWith('active-thread-1');
    expect(context.recentMessages).toHaveLength(1);
  });

  it('returns empty conversation when no active thread exists', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetActiveThread.mockResolvedValue(null);

    const context = await contextService.getAgentContext('user-1', {
      agentId: 'agent-1',
      includeConversation: true,
    });

    expect(mockGetActiveThread).toHaveBeenCalledWith('user-1');
    expect(mockGetThreadContext).not.toHaveBeenCalled();
    expect(context.conversationSummary).toBeNull();
    expect(context.recentMessages).toEqual([]);
  });

  // ==========================================================================
  // includeConversation defaults to true
  // ==========================================================================

  it('defaults includeConversation to true', async () => {
    mockGetAgent.mockResolvedValue(createTestAgentWorkspace());
    mockGetActiveThread.mockResolvedValue({ id: 'thread-1' });
    mockGetThreadContext.mockResolvedValue({
      compactionSummary: null,
      messages: [createTestMessage()],
    });

    await contextService.getAgentContext('user-1', { agentId: 'agent-1' });

    expect(mockGetActiveThread).toHaveBeenCalled();
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

  it('keeps only the last 20 messages', async () => {
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

    expect(context.recentMessages).toHaveLength(20);
    expect(context.recentMessages[0].content).toBe('Message 5');
    expect(context.recentMessages[19].content).toBe('Message 24');
  });
});
