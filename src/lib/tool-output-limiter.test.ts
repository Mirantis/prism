/**
 * Tool Output Limiter Tests
 */

import { describe, it, expect } from 'vitest';
import {
  withOutputLimits,
  truncateHeadTail,
  stringifyToolOutput,
} from './tool-output-limiter';

describe('stringifyToolOutput', () => {
  it('returns plain strings as-is', () => {
    expect(stringifyToolOutput('hello')).toBe('hello');
  });

  it('extracts text from MCP CallToolResult format', () => {
    const mcpResult = {
      content: [
        { type: 'text', text: 'line one' },
        { type: 'image', data: 'abc' },
        { type: 'text', text: 'line two' },
      ],
    };
    expect(stringifyToolOutput(mcpResult)).toBe('line one\nline two');
  });

  it('skips MCP content entries with empty text', () => {
    const mcpResult = {
      content: [
        { type: 'text', text: '' },
        { type: 'text', text: 'valid' },
      ],
    };
    expect(stringifyToolOutput(mcpResult)).toBe('valid');
  });

  it('JSON-stringifies plain objects', () => {
    const obj = { pods: 42, namespace: 'default' };
    expect(stringifyToolOutput(obj)).toBe(JSON.stringify(obj));
  });

  it('JSON-stringifies arrays', () => {
    const arr = [1, 2, 3];
    expect(stringifyToolOutput(arr)).toBe('[1,2,3]');
  });

  it('handles null and undefined', () => {
    expect(stringifyToolOutput(null)).toBe('null');
    expect(stringifyToolOutput(undefined)).toBe('');
  });
});

describe('truncateHeadTail', () => {
  it('keeps head (80%) and tail (20%) with message in between', () => {
    const text = 'A'.repeat(100);
    const result = truncateHeadTail(text, 50);

    // Head = 40 chars, tail = 10 chars
    expect(result.startsWith('A'.repeat(40))).toBe(true);
    expect(result.endsWith('A'.repeat(10))).toBe(true);
    expect(result).toContain('[... 50 chars omitted');
    expect(result).toContain('100 chars total');
  });

  it('includes guidance message in truncation notice', () => {
    const text = 'X'.repeat(200);
    const result = truncateHeadTail(text, 100);
    expect(result).toContain(
      'Use more targeted queries (e.g., filter by namespace, limit output) for complete results.'
    );
  });

  it('reports correct omitted and total char counts', () => {
    const text = 'B'.repeat(1000);
    const result = truncateHeadTail(text, 300);
    // head = 240, tail = 60, omitted = 1000 - 240 - 60 = 700
    expect(result).toContain('700 chars omitted');
    expect(result).toContain('1000 chars total');
  });
});

describe('withOutputLimits', () => {
  it('passes through output under the limit', async () => {
    const tools = {
      myTool: {
        description: 'test tool',
        inputSchema: { type: 'object' as const },
      },
    };

    const wrapped = withOutputLimits(tools, 1000);
    const toModelOutput = (wrapped.myTool as Record<string, unknown>).toModelOutput as (opts: {
      output: unknown;
    }) => Promise<{ type: string; value: string }>;

    const result = await toModelOutput({ output: 'short output' });
    expect(result).toEqual({ type: 'text', value: 'short output' });
  });

  it('truncates output exceeding the limit', async () => {
    const tools = {
      myTool: {
        description: 'test tool',
        inputSchema: { type: 'object' as const },
      },
    };

    const wrapped = withOutputLimits(tools, 100);
    const toModelOutput = (wrapped.myTool as Record<string, unknown>).toModelOutput as (opts: {
      output: unknown;
    }) => Promise<{ type: string; value: string }>;

    const largeOutput = 'Z'.repeat(1000);
    const result = await toModelOutput({ output: largeOutput });

    expect(result.type).toBe('text');
    expect(result.value).toContain('[...');
    expect(result.value).toContain('chars omitted');
    // Should be much shorter than original
    expect(result.value.length).toBeLessThan(1000);
  });

  it('handles MCP CallToolResult format with truncation', async () => {
    const tools = {
      kubectl: {
        description: 'run kubectl',
        inputSchema: { type: 'object' as const },
      },
    };

    const wrapped = withOutputLimits(tools, 50);
    const toModelOutput = (wrapped.kubectl as Record<string, unknown>).toModelOutput as (opts: {
      output: unknown;
    }) => Promise<{ type: string; value: string }>;

    const mcpResult = {
      content: [{ type: 'text', text: 'POD'.repeat(500) }],
    };

    const result = await toModelOutput({ output: mcpResult });
    expect(result.type).toBe('text');
    expect(result.value).toContain('[...');
  });

  it('preserves all original tool properties', () => {
    const tools = {
      myTool: {
        description: 'test tool',
        inputSchema: { type: 'object' as const },
        execute: async () => 'result',
      },
    };

    const wrapped = withOutputLimits(tools, 1000);
    expect((wrapped.myTool as Record<string, unknown>).description).toBe('test tool');
    expect((wrapped.myTool as Record<string, unknown>).execute).toBe(
      (tools.myTool as Record<string, unknown>).execute
    );
  });

  it('passes through tools that already define their own toModelOutput', async () => {
    const customToModelOutput = async ({ output }: { output: unknown }) => ({
      type: 'content' as const,
      value: [
        { type: 'text' as const, text: 'custom' },
        { type: 'image-data' as const, data: 'abc123', mediaType: 'image/png' },
      ],
    });

    const tools = {
      plainTool: {
        description: 'plain tool',
        inputSchema: { type: 'object' as const },
      },
      multimodalTool: {
        description: 'multimodal tool',
        inputSchema: { type: 'object' as const },
        toModelOutput: customToModelOutput,
      },
    };

    const wrapped = withOutputLimits(tools, 1000);

    // multimodalTool should be passed through completely untouched
    expect((wrapped.multimodalTool as Record<string, unknown>).toModelOutput).toBe(customToModelOutput);

    // plainTool should get the limiter's toModelOutput
    expect((wrapped.plainTool as Record<string, unknown>).toModelOutput).not.toBeUndefined();
    expect((wrapped.plainTool as Record<string, unknown>).toModelOutput).not.toBe(customToModelOutput);

    // Verify the passthrough toModelOutput still works
    const result = await customToModelOutput({ output: {} });
    expect(result.type).toBe('content');
    expect(result.value).toHaveLength(2);
    expect(result.value[1].type).toBe('image-data');
  });
});
