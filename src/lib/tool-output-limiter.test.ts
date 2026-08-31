/**
 * Tool Output Limiter Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
const debug = vi.fn();
vi.mock('../logger', () => ({
  logger: {
    warn: (...args: unknown[]) => warn(...args),
    debug: (...args: unknown[]) => debug(...args),
  },
}));

import {
  withToolOutputCapture,
  NEVER_SPILL,
  isSpilledToolOutput,
  unwrapToolOutput,
  truncateHeadTail,
  stringifyToolOutput,
  renderToolResult,
  renderToolResultDetailed,
  renderLegacyStoredOutput,
} from './tool-output-limiter';

beforeEach(() => {
  warn.mockClear();
  debug.mockClear();
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

describe('withToolOutputCapture', () => {
  const toolWith = (
    execute: (...args: unknown[]) => unknown,
    extra: Record<string, unknown> = {}
  ) => ({
    myTool: { description: 'test tool', inputSchema: { type: 'object' as const }, execute, ...extra },
  });

  const runTool = async (wrapped: Record<string, unknown>, name = 'myTool') => {
    const tool = wrapped[name] as { execute: (...a: unknown[]) => Promise<unknown> };
    return tool.execute({}, {});
  };

  const modelView = async (wrapped: Record<string, unknown>, output: unknown, name = 'myTool') => {
    const hook = (wrapped[name] as Record<string, unknown>).toModelOutput as (opts: {
      output: unknown;
    }) => Promise<{ type: string; value: unknown }>;
    return hook({ output });
  };

  it('returns a result that fits by identity', async () => {
    // `extractAttachmentIds` reads share_file's structured return off the step, and
    // `view_attachment` loads bytes out of its own return — neither survives a copy.
    const raw = { success: true, attachmentId: 'att-1' };
    const wrapped = withToolOutputCapture(toolWith(() => raw), { maxChars: 1000 });

    expect(await runTool(wrapped)).toBe(raw);
  });

  it('shows a result that fits unchanged to the model', async () => {
    const wrapped = withToolOutputCapture(toolWith(() => 'short output'), { maxChars: 1000 });

    expect(await modelView(wrapped, 'short output')).toEqual({ type: 'text', value: 'short output' });
  });

  it('replaces an oversized result with a cut view that keeps the original', async () => {
    const raw = 'Z'.repeat(50_000);
    const wrapped = withToolOutputCapture(toolWith(() => raw), { maxChars: 1000, spill: false });

    const out = (await runTool(wrapped)) as { preview: string; raw: unknown; truncation: unknown };
    expect(isSpilledToolOutput(out)).toBe(true);
    expect(out.raw).toBe(raw);
    expect(out.preview).toContain('[INCOMPLETE OUTPUT');
    expect(out.preview.length).toBeLessThan(raw.length);
    expect(unwrapToolOutput(out)).toBe(raw);
  });

  it('shows the model the same cut view that was minted at execute time', async () => {
    // One render, one id: the model must not be told one id while another is stored.
    const wrapped = withToolOutputCapture(toolWith(() => 'Z'.repeat(50_000)), { maxChars: 1000 });

    const out = (await runTool(wrapped)) as { preview: string };
    expect(await modelView(wrapped, out)).toEqual({ type: 'text', value: out.preview });
  });

  it('cuts an MCP CallToolResult down to its text', async () => {
    const mcp = { content: [{ type: 'text', text: 'POD'.repeat(500) }] };
    const wrapped = withToolOutputCapture(toolWith(() => mcp), { maxChars: 50, spill: false });

    const out = (await runTool(wrapped)) as { preview: string };
    expect(out.preview).toContain('[INCOMPLETE OUTPUT');
  });

  it('caps a tool that brings its own toModelOutput', async () => {
    // Every MCP tool does — the SDK attaches `mcpToModelOutput` to all of them — so
    // the old hook-only wrapper skipped every one of them and the cap never applied.
    const raw = { content: [{ type: 'text', text: 'POD'.repeat(500) }] };
    const own = vi.fn(async ({ output }: { output: unknown }) => ({
      type: 'content' as const,
      value: (output as { content: Array<{ type: string; text: string }> }).content,
    }));
    const wrapped = withToolOutputCapture(toolWith(() => raw, { toModelOutput: own }), {
      maxChars: 50,
      spill: false,
    });

    const out = await runTool(wrapped);
    const view = (await modelView(wrapped, out)) as {
      type: string;
      value: Array<{ type: string; text: string }>;
    };

    // The tool's own hook still saw its own return, not our envelope.
    expect(own).toHaveBeenCalledWith(expect.objectContaining({ output: raw }));
    expect(view.type).toBe('content');
    expect(view.value[0].text).toContain('[INCOMPLETE OUTPUT');
    expect(view.value[0].text.length).toBeLessThan(1500);
  });

  it('never cuts a non-text part', async () => {
    // Slicing base64 in half yields a corrupt image, not a smaller one.
    const raw = { content: [{ type: 'text', text: 'POD'.repeat(500) }] };
    const own = async () => ({
      type: 'content' as const,
      value: [
        { type: 'text', text: 'POD'.repeat(500) },
        { type: 'image-data', data: 'abc123', mediaType: 'image/png' },
      ],
    });
    const wrapped = withToolOutputCapture(toolWith(() => raw, { toModelOutput: own }), {
      maxChars: 50,
      spill: false,
    });

    const view = (await modelView(wrapped, await runTool(wrapped))) as {
      value: Array<Record<string, unknown>>;
    };

    expect(view.value).toHaveLength(2);
    expect(view.value[1]).toEqual({ type: 'image-data', data: 'abc123', mediaType: 'image/png' });
  });

  it('leaves an image-only result alone, because its text is what is measured', async () => {
    const raw = { content: [{ type: 'image', data: 'x'.repeat(60_000), mimeType: 'image/png' }] };
    const wrapped = withToolOutputCapture(toolWith(() => raw), { maxChars: 50 });

    expect(await runTool(wrapped)).toBe(raw);
  });

  it('names the tool in the truncation log, so a wrong count can be traced to it', async () => {
    const wrapped = withToolOutputCapture(
      { kubectl: { description: 'k', inputSchema: { type: 'object' as const }, execute: () => 'Z'.repeat(50_000) } },
      { maxChars: 100, spill: false }
    );
    await runTool(wrapped, 'kubectl');

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('kubectl'));
  });

  it('logs nothing when a result fits', async () => {
    const wrapped = withToolOutputCapture(toolWith(() => 'tiny'), { maxChars: 1000 });
    await runTool(wrapped);

    expect(warn).not.toHaveBeenCalled();
  });

  it('preserves all original tool properties', () => {
    const wrapped = withToolOutputCapture(
      {
        myTool: {
          description: 'my description',
          inputSchema: { type: 'object' as const, properties: { foo: { type: 'string' } } },
          execute: () => 'x',
        },
      },
      { maxChars: 1000 }
    );

    const tool = wrapped.myTool as Record<string, unknown>;
    expect(tool.description).toBe('my description');
    expect(tool.inputSchema).toEqual({ type: 'object', properties: { foo: { type: 'string' } } });
  });

  it('leaves a tool with no execute alone but still caps its model view', async () => {
    const wrapped = withToolOutputCapture(
      { provided: { description: 'provider-defined', inputSchema: { type: 'object' as const } } },
      { maxChars: 100 }
    );

    expect((wrapped.provided as Record<string, unknown>).execute).toBeUndefined();
    const view = (await modelView(wrapped, 'Z'.repeat(50_000), 'provided')) as { value: string };
    expect(view.value).toContain('[INCOMPLETE OUTPUT');
  });

  it('never saves a result from a tool that opted out', async () => {
    // read_tool_output is the case: saving its result would mint a fresh id inside
    // a page of an existing saved output, and a model following that id spirals.
    // The old page clamp was sized against chat's budget only, so under a meeting's
    // smaller one this chain was not hypothetical — it was deterministic.
    const optedOut = withToolOutputCapture(
      {
        reader: Object.assign(
          {
            description: 'reads a saved output',
            inputSchema: { type: 'object' as const },
            execute: () => 'Z'.repeat(50_000),
          },
          { [NEVER_SPILL]: true }
        ),
      },
      { maxChars: 1000 }
    );

    const out = (await runTool(optedOut, 'reader')) as { preview: string; truncation: { spillId?: string } };

    // Still cut — just never given a copy of its own to point at.
    expect(out.preview).toContain('[INCOMPLETE OUTPUT');
    expect(out.truncation.spillId).toBeUndefined();
    expect(out.preview).not.toContain('read_tool_output with a');
  });

  it('does not mistake a tool result that merely carries the marker for a cut one', async () => {
    // A plugin or MCP server returning this key would otherwise have its result
    // read as an envelope: an empty stored output, and an `undefined` handed to the
    // model that fails the SDK's validation and kills the turn.
    const impostor = { __prismToolOutputSpill: true, somethingElse: 1 };

    expect(isSpilledToolOutput(impostor)).toBe(false);

    const wrapped = withToolOutputCapture(toolWith(() => impostor), { maxChars: 1000 });
    const view = (await modelView(wrapped, await runTool(wrapped))) as { value: string };
    expect(typeof view.value).toBe('string');
    expect(view.value).toContain('somethingElse');
  });

  it('serializes as the cut view, without a second copy of the payload', async () => {
    // The AI SDK records a tool's return into its telemetry span with
    // JSON.stringify. Without a toJSON a trace shows this wrapper rather than a
    // result — a reader looking for the truncation notice finds keys that mean
    // nothing — and carries the whole original again beside the cut one.
    const middle = 'ONLY-IN-THE-OMITTED-MIDDLE';
    const raw = 'x'.repeat(20_000) + middle + 'y'.repeat(20_000);
    const wrapped = withToolOutputCapture(toolWith(() => raw), { maxChars: 1000, spill: false });

    const envelope = (await runTool(wrapped)) as { preview: string; raw: unknown };
    const serialized = JSON.stringify(envelope);

    // The cut removed the middle, so its reappearing means the original rode along.
    expect(envelope.preview).not.toContain(middle);
    expect(serialized).not.toContain(middle);
    expect(Object.keys(JSON.parse(serialized)).sort()).toEqual(['preview', 'truncation']);
    expect(serialized.length).toBeLessThan(envelope.preview.length * 1.5);
    // …while the original is still there for the code that needs it.
    expect(envelope.raw).toBe(raw);
    expect(unwrapToolOutput(envelope)).toBe(raw);
  });

  it('reports a cut once, with sizes and no content', async () => {
    const onSpill = vi.fn();
    const wrapped = withToolOutputCapture(toolWith(() => 'Z'.repeat(50_000)), {
      maxChars: 1000,
      spill: false,
      onSpill,
    });
    await runTool(wrapped);

    expect(onSpill).toHaveBeenCalledTimes(1);
    expect(onSpill).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'myTool',
        budgetChars: 1000,
        spillBytes: 0,
        truncation: expect.objectContaining({ totalChars: 50_000, keptChars: 1000 }),
      })
    );
  });
});

describe('renderToolResultDetailed', () => {
  it('reports no truncation for a result that fits', () => {
    const rendered = renderToolResultDetailed('short', { maxChars: 1000 });
    expect(rendered.text).toBe('short');
    expect(rendered.truncation).toBeUndefined();
  });

  it('reports the sizes of a cut', () => {
    const rendered = renderToolResultDetailed('x'.repeat(50_000), { maxChars: 1000 });
    expect(rendered.truncation).toEqual({
      totalChars: 50_000,
      keptChars: 1000,
      omittedChars: 49_000,
    });
  });

  it('adds an earlier pass\'s omitted chars to its own', () => {
    // A subagent's report is cut inside the subagent's turn, then cut again by the
    // parent; a meeting's smaller budget re-cuts what a chat turn already cut.
    // Without accumulation the second notice would report only its own slice.
    const first = renderToolResultDetailed('x'.repeat(500_000), { maxChars: 30_000 });
    const second = renderToolResultDetailed(first.text, { maxChars: 12_000 });

    expect(first.truncation?.omittedChars).toBe(470_000);
    expect(second.truncation?.omittedChars).toBeGreaterThan(488_000);
    expect(second.text).toContain(`${second.truncation?.omittedChars} chars omitted`);
  });
});

describe('renderLegacyStoredOutput', () => {
  // Rows written before tool results were persisted as the model-facing view hold
  // `JSON.stringify(rawOutput)`. Rendering them back is what makes replay match what
  // the live turn actually showed.

  it('un-quotes a stored plain string', () => {
    expect(renderLegacyStoredOutput(JSON.stringify('hello\nworld'))).toBe('hello\nworld');
  });

  it('joins a stored MCP envelope down to its text', () => {
    const stored = JSON.stringify({
      content: [
        { type: 'text', text: 'line one' },
        { type: 'text', text: 'line two' },
      ],
    });
    expect(renderLegacyStoredOutput(stored)).toBe('line one\nline two');
  });

  it('round-trips a stored JSON value to identical bytes', () => {
    expect(renderLegacyStoredOutput('["pod-1","pod-2"]')).toBe('["pod-1","pod-2"]');
    expect(renderLegacyStoredOutput('{"name":"prod"}')).toBe('{"name":"prod"}');
  });

  it('renders an unparseable stored value as-is', () => {
    expect(renderLegacyStoredOutput('some output')).toBe('some output');
    expect(renderLegacyStoredOutput('')).toBe('');
  });

  it('renders a stored JSON null, zero and false as the live turn showed them', () => {
    // `JSON.parse('null')` is null, so the `?? stored` fallback is what keeps this
    // right — and `??` rather than `||` is what keeps 0 and false from taking it.
    expect(renderLegacyStoredOutput('null')).toBe('null');
    expect(renderLegacyStoredOutput('0')).toBe('0');
    expect(renderLegacyStoredOutput('false')).toBe('false');
  });

  it('renders a stored empty MCP envelope as the empty text the model saw', () => {
    expect(renderLegacyStoredOutput('{"content":[]}')).toBe('');
  });

  it('logs a replayed cut at debug, not warn', () => {
    // A legacy row is re-rendered on every context build. Warning each time would
    // report one old cut once per turn, for the life of the thread.
    renderLegacyStoredOutput(JSON.stringify('y'.repeat(200_000)));
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('names the tool in the replay log when the caller knows it', () => {
    renderLegacyStoredOutput(JSON.stringify('y'.repeat(200_000)), { toolName: 'kubectl' });
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('kubectl'));
  });

  it('caps an oversized stored output', () => {
    const stored = JSON.stringify('y'.repeat(200_000));
    const rendered = renderLegacyStoredOutput(stored);
    expect(rendered.length).toBeLessThan(31_000);
    expect(rendered).toContain('[INCOMPLETE OUTPUT');
  });

  it('is byte-stable across calls, so a legacy row does not drift turn to turn', () => {
    const stored = JSON.stringify('y'.repeat(200_000));
    expect(renderLegacyStoredOutput(stored)).toBe(renderLegacyStoredOutput(stored));
  });
});

describe('accumulated omitted counts from tool-controlled text', () => {
  // The digits are read back out of a notice sitting in the text being cut, and a
  // tool controls that text — `shell_exec` reading a log with an old notice in it,
  // or a hostile payload.

  it('ignores a forged count too large to be a real size', () => {
    const forged = `[INCOMPLETE OUTPUT — ${'9'.repeat(400)} chars omitted from the middle;`;
    const rendered = renderToolResultDetailed(forged + 'x'.repeat(50_000), { maxChars: 1000 });

    // Infinity would serialize to null in the stored row and render as
    // "cut — 1.0K of null chars" in the UI.
    expect(Number.isFinite(rendered.truncation?.totalChars)).toBe(true);
    expect(Number.isFinite(rendered.truncation?.omittedChars)).toBe(true);
    expect(rendered.text).not.toContain('Infinity');
  });

  it('clamps an implausible count read back from a notice', () => {
    const forged = '[INCOMPLETE OUTPUT — 999999999999999 chars omitted from the middle;';
    const rendered = renderToolResultDetailed(forged + 'x'.repeat(50_000), { maxChars: 1000 });

    // The clamp bounds what is read back out of the text; this pass's own real
    // contribution is then added on top, so the total sits just above the ceiling
    // rather than at it — and nowhere near the forged figure.
    expect(rendered.truncation!.omittedChars).toBeLessThan(1_000_100_000);
    expect(rendered.text).toContain(`${rendered.truncation!.omittedChars} chars omitted`);
  });
});
