/**
 * Task Tool Tests
 *
 * Tests the createTaskTool factory and its execute function.
 */

import { describe, it, expect, vi } from 'vitest';

const { mockJsonSchema } = vi.hoisted(() => ({
  mockJsonSchema: vi.fn((schema: unknown) => schema),
}));

vi.mock('ai', () => ({
  jsonSchema: mockJsonSchema,
}));

vi.mock('./backend-client', () => ({}));

import { createTaskTool } from './task-tool';
import type { SubagentInfo } from './backend-client';
import type { InvokeRequest, InvokeResponse } from '../types';

function createMockInvoker() {
  return vi.fn<(req: InvokeRequest) => Promise<InvokeResponse>>().mockResolvedValue({
    response: 'Subagent response',
    toolCalls: [],
    steps: [],
  });
}

const subagents: SubagentInfo[] = [
  { id: 'sub-1', name: 'Research Bot', description: 'Researches topics' },
  { id: 'sub-2', name: 'Code Bot', description: 'Writes code' },
];

describe('createTaskTool', () => {
  it('returns a tool with description and execute', () => {
    const tool = createTaskTool(subagents, 'user-1', createMockInvoker());

    expect(tool.description).toBeDefined();
    expect(tool.execute).toBeDefined();
  });

  it('execute invokes the matched subagent', async () => {
    const invoker = createMockInvoker();
    const tool = createTaskTool(subagents, 'user-1', invoker);

    const result = await tool.execute!(
      { description: 'Research AI', prompt: 'Find papers on AI', subagent_type: 'Research Bot' },
      { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal },
    );

    expect(invoker).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'sub-1',
      mode: 'subagent',
      prompt: 'Research AI\nFind papers on AI',
    });
    expect(result).toEqual({
      response: 'Subagent response',
      toolCalls: [],
    });
  });

  it('returns error for unknown subagent type', async () => {
    const invoker = createMockInvoker();
    const tool = createTaskTool(subagents, 'user-1', invoker);

    const result = await tool.execute!(
      { description: 'Do stuff', prompt: 'Do something', subagent_type: 'Unknown Bot' },
      { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal },
    );

    expect(invoker).not.toHaveBeenCalled();
    expect(result).toEqual({
      error: 'Unknown subagent type: "Unknown Bot". Available: Research Bot, Code Bot',
    });
  });

  it('passes subagent response and tool calls through', async () => {
    const invoker = createMockInvoker();
    invoker.mockResolvedValue({
      response: 'Found 3 papers.',
      toolCalls: [
        { tool: 'memory_search', input: '{}', output: '[]', success: true, timestamp: '2026-01-01T00:00:00Z' },
      ],
      steps: [],
    });

    const tool = createTaskTool(subagents, 'user-1', invoker);

    const result = await tool.execute!(
      { description: 'Research', prompt: 'Find papers', subagent_type: 'Research Bot' },
      { toolCallId: 'tc-1', messages: [], abortSignal: new AbortController().signal },
    );

    expect(result).toEqual({
      response: 'Found 3 papers.',
      toolCalls: [
        { tool: 'memory_search', input: '{}', output: '[]', success: true, timestamp: '2026-01-01T00:00:00Z' },
      ],
    });
  });
});
