/**
 * Tool Output Limiter Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('../logger', () => ({ logger: { warn: (...args: unknown[]) => warn(...args) } }));

import {
  withOutputLimits,
  truncateHeadTail,
  stringifyToolOutput,
  renderToolResult,
} from './tool-output-limiter';

beforeEach(() => {
  warn.mockClear();
});

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
    expect(result).toContain('50 chars omitted');
    expect(result).toContain('100 chars total');
  });

  it('states that the output is incomplete and forbids stating a count', () => {
    const text = 'X'.repeat(200);
    const result = truncateHeadTail(text, 100);
    // Wording, not decoration: a model handed a silently-clipped list reports the
    // entries it can see as the whole set.
    expect(result).toContain('INCOMPLETE OUTPUT');
    expect(result).toContain('Do not state a count, a total, or that this is all of them.');
    expect(result).toContain('a filter, fewer fields, or the next page');
  });

  it('appends channel-specific guidance when given', () => {
    const result = truncateHeadTail('X'.repeat(200), 100, 'Say it out loud.');
    expect(result).toContain('the next page. Say it out loud.]');
  });

  it('omits the guidance sentence when none is given', () => {
    expect(truncateHeadTail('X'.repeat(200), 100)).toContain('the next page.]');
  });

  it('reports correct omitted and total char counts', () => {
    const text = 'B'.repeat(1000);
    const result = truncateHeadTail(text, 300);
    // head = 240, tail = 60, omitted = 1000 - 240 - 60 = 700
    expect(result).toContain('700 chars omitted');
    expect(result).toContain('1000 chars total');
  });
});

describe('renderToolResult', () => {
  it('returns text that fits the budget unchanged', () => {
    expect(renderToolResult('three pods are down', { maxChars: 100 })).toBe(
      'three pods are down'
    );
  });

  it('leaves a result just over the budget alone rather than paying for a notice', () => {
    // The notice costs more than the handful of chars a cut here would save.
    const text = 'a'.repeat(1_400);
    expect(renderToolResult(text, { maxChars: 1_000 })).toBe(text);
  });

  it('cuts head+tail once the result is well past the budget', () => {
    const result = renderToolResult('a'.repeat(5_000) + 'END', { maxChars: 1_000 });
    expect(result.startsWith('a'.repeat(800))).toBe(true);
    expect(result.endsWith('END')).toBe(true);
    expect(result).toContain('INCOMPLETE OUTPUT');
  });

  it('renders the MCP content shape before measuring it', () => {
    const output = { content: [{ type: 'text', text: 'pod-a' }, { type: 'text', text: 'pod-b' }] };
    expect(renderToolResult(output, { maxChars: 100 })).toBe('pod-a\npod-b');
  });

  it('carries channel guidance into the notice', () => {
    const result = renderToolResult('z'.repeat(5_000), {
      maxChars: 1_000,
      extraGuidance: 'The call is your only channel.',
    });
    expect(result).toContain('The call is your only channel.');
  });

  it('coerces a value JSON cannot serialize instead of throwing mid-turn', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(renderToolResult(cyclic)).toBe('[object Object]');
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
    expect(result.value).toContain('[INCOMPLETE OUTPUT');
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
    expect(result.value).toContain('[INCOMPLETE OUTPUT');
  });

  it('names the tool in the truncation log, so a wrong count can be traced to it', async () => {
    const tools = {
      kubectl_get: { description: 'run kubectl', inputSchema: { type: 'object' as const } },
    };

    const wrapped = withOutputLimits(tools, 100);
    const toModelOutput = (wrapped.kubectl_get as Record<string, unknown>).toModelOutput as (opts: {
      output: unknown;
    }) => Promise<{ type: string; value: string }>;

    await toModelOutput({ output: 'Z'.repeat(1000) });

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kubectl_get'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kept 100 content chars of 1000'));
  });

  it('logs nothing when a result fits', async () => {
    const tools = { small: { description: 'small', inputSchema: { type: 'object' as const } } };
    const wrapped = withOutputLimits(tools, 100);
    const toModelOutput = (wrapped.small as Record<string, unknown>).toModelOutput as (opts: {
      output: unknown;
    }) => Promise<{ type: string; value: string }>;

    await toModelOutput({ output: 'fine' });

    expect(warn).not.toHaveBeenCalled();
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
