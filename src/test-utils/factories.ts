/**
 * Test Factories
 *
 * Helpers for creating test data with sensible defaults.
 */

import { v4 as uuidv4 } from 'uuid';
import type { AgentContext, InvokeRequest, InvokeResponse } from '../types';

export interface TestAgentWorkspace {
  id: string;
  userId: string;
  name: string;
  agentType: 'AGENT' | 'SUBAGENT';
  soulMd: string;
  userMd: string;
  memoryMd: string;
  heartbeatMd: string;
  visionMd: string;
  bootstrapMd: string;
  agentMd: string;
  heartbeatIntervalMs: number;
  proactivity: number;
  verbosity: number;
  timezone: string;
  dailyResetHour: number;
  idleTimeoutMins: number | null;
  status: 'IDLE' | 'RUNNING';
  lastHeartbeat: Date | null;
  currentSessionId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function createTestAgentWorkspace(overrides: Partial<TestAgentWorkspace> = {}): TestAgentWorkspace {
  const userId = overrides.userId || `user-${uuidv4()}`;
  return {
    id: `agent-${uuidv4()}`,
    userId,
    name: 'Prism',
    agentType: 'AGENT',
    soulMd: '# Soul\nYou are Prism, a helpful assistant.',
    userMd: '# User\nTest user preferences.',
    memoryMd: '# Memory\nNo memories yet.',
    heartbeatMd: '# Heartbeat Instructions\n(No checks configured)',
    visionMd: '',
    bootstrapMd: '',
    agentMd: '',
    heartbeatIntervalMs: 28800000,
    proactivity: 3,
    verbosity: 3,
    timezone: 'UTC',
    dailyResetHour: 4,
    idleTimeoutMins: null,
    status: 'IDLE',
    lastHeartbeat: null,
    currentSessionId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

export function createTestAgentContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    soulMd: 'You are a helpful assistant.',
    userMd: 'Name: Test User\nTimezone: UTC',
    memoryMd: 'No memories yet.',
    heartbeatMd: 'Check for new items every 5 minutes.',
    bootstrapMd: 'Welcome! Let me help you get started.',
    visionMd: '',
    agentMd: '',
    agentName: 'TestAgent',
    agentId: 'agent-test-123',
    userId: 'user-test-456',
    proactivity: 3,
    verbosity: 3,
    model: null,
    isBootstrapPhase: false,
    conversationSummary: null,
    recentMessages: [],
    ...overrides,
  };
}

export function createTestInvokeRequest(overrides?: Partial<InvokeRequest>): InvokeRequest {
  return {
    userId: 'user-test-456',
    agentId: 'agent-test-123',
    mode: 'chat',
    prompt: 'What pods are running?',
    ...overrides,
  };
}

export function createTestInvokeResponse(overrides?: Partial<InvokeResponse>): InvokeResponse {
  return {
    response: 'Here are the running pods.',
    toolCalls: [],
    steps: [],
    ...overrides,
  };
}

export interface TestMemoryEntry {
  id: string;
  agentId: string;
  content: string;
  category: string;
  importance: number;
  embedding: number[] | null;
  createdAt: Date;
}

export function createTestMemoryEntry(overrides: Partial<TestMemoryEntry> = {}): TestMemoryEntry {
  return {
    id: `entry-${uuidv4()}`,
    agentId: `agent-${uuidv4()}`,
    content: 'User decided to use TypeScript for the project',
    category: 'decision',
    importance: 7,
    embedding: null,
    createdAt: new Date(),
    ...overrides,
  };
}
