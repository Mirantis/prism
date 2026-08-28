/**
 * read_tool_output Tests
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const warn = vi.fn();
vi.mock('../../logger', () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
const trackEvent = vi.fn();
vi.mock('../../lib/telemetry', () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { getReadToolOutputTool, READ_TOOL_OUTPUT_NAME } from '../read-tool-output';
import { writeToolOutput } from '../../lib/tool-output-store';
import { withToolOutputCapture, isSpilledToolOutput } from '../../lib/tool-output-limiter';

type ReadResult = { success: boolean; output?: string; error?: string };

let dataDir: string;
const originalDataDir = process.env.PRISM_DATA_DIR;

const run = async (
  input: Record<string, unknown>,
  ctx = { userId: 'u1', agentId: 'a1', mode: 'chat' },
): Promise<ReadResult> => {
  const tools = getReadToolOutputTool(ctx);
  const tool = tools[READ_TOOL_OUTPUT_NAME] as {
    execute: (i: unknown, o: unknown) => Promise<ReadResult>;
  };
  return tool.execute(input, {});
};

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'prism-read-'));
  process.env.PRISM_DATA_DIR = dataDir;
  warn.mockClear();
  trackEvent.mockClear();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.PRISM_DATA_DIR;
  else process.env.PRISM_DATA_DIR = originalDataDir;
  await fs.rm(dataDir, { recursive: true, force: true });
});

describe('read_tool_output', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

  it('finds a match and reports it with its true line number', async () => {
    const { id } = await writeToolOutput(`${lines(50)}\nneedle here\n${lines(50)}`);

    const result = await run({ id, pattern: 'needle' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('51: needle here');
    expect(result.output).toContain('1 matching line of 101');
  });

  it('gives context around each match', async () => {
    const { id } = await writeToolOutput('a\nb\nneedle\nd\ne');

    const result = await run({ id, pattern: 'needle', context: 1 });

    expect(result.output).toContain('2: b');
    expect(result.output).toContain('4: d');
    expect(result.output).not.toContain('1: a');
  });

  it('says so plainly when nothing matches, instead of dumping the output', async () => {
    const { id } = await writeToolOutput(lines(500));

    const result = await run({ id, pattern: 'nothing-like-this' });

    expect(result.success).toBe(true);
    expect(result.output).toContain('No line matches');
    expect(result.output!.length).toBeLessThan(200);
  });

  it('caps how many matches it shows and says how to narrow', async () => {
    const { id } = await writeToolOutput(Array.from({ length: 400 }, () => 'match').join('\n'));

    const result = await run({ id, pattern: 'match', context: 0 });

    expect(result.output).toContain('400 matching lines, showing the first 50');
    expect(result.output).toContain('refine the pattern');
  });

  it('refuses an invalid pattern without failing the turn', async () => {
    const { id } = await writeToolOutput('anything');

    const result = await run({ id, pattern: '([unclosed' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a valid regular expression');
  });

  it('pages sequentially with a footer naming where it stopped', async () => {
    const { id } = await writeToolOutput(lines(1000));

    const result = await run({ id, offset: 10, limit: 5 });

    expect(result.output).toContain('10: line 10');
    expect(result.output).toContain('14: line 14');
    expect(result.output).toContain('(showing lines 10-14 of 1000, use offset to read more)');
  });

  it('defaults a sequential read to a page far smaller than a file read', async () => {
    // Walking a saved output should be visibly the wrong way round.
    const { id } = await writeToolOutput(lines(1000));

    const result = await run({ id });

    expect(result.output).toContain('(showing lines 1-200 of 1000');
  });

  it('clamps a page to fit the smallest channel budget whole', async () => {
    const { id } = await writeToolOutput(Array.from({ length: 400 }, () => 'x'.repeat(400)).join('\n'));

    const result = await run({ id, offset: 1, limit: 400 });

    expect(result.output!.length).toBeLessThan(9_000);
    expect(result.output).toContain('This page was cut at');
  });

  it('starts no chain when it runs inside the output capture, even on a call budget', async () => {
    // The real seam: a read-back is itself a tool result, so it passes through the
    // capture wrapper like any other. Sized against chat's budget alone, a page was
    // over a meeting's 12,000 and got cut *and saved again* — a fresh id inside a
    // page of an existing saved output, which a model would follow and spiral.
    // Exercising the unwrapped tool cannot catch that; this does.
    const { id } = await writeToolOutput(Array.from({ length: 2000 }, () => 'x'.repeat(400)).join('\n'));
    const before = await fs.readdir(path.join(dataDir, 'tool-outputs'));

    const wrapped = withToolOutputCapture(
      getReadToolOutputTool({ userId: 'u1', agentId: 'a1', mode: 'meeting' }),
      { maxChars: 12_000 },
    );
    const out = await (
      wrapped[READ_TOOL_OUTPUT_NAME] as unknown as {
        execute: (i: unknown, o: unknown) => Promise<unknown>;
      }
    ).execute({ id, offset: 1, limit: 2000 }, {});

    // Delivered whole, and no second copy on disk.
    expect(isSpilledToolOutput(out)).toBe(false);
    expect(await fs.readdir(path.join(dataDir, 'tool-outputs'))).toEqual(before);
  });

  it('reports an expired copy as a sentence, not an error the turn has to handle', async () => {
    const result = await run({ id: '0f9a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('no longer stored');
    expect(result.error).toContain('about 7 days');
  });

  it('refuses anything that is not one of our ids', async () => {
    const outside = path.join(dataDir, 'agent.db');
    await fs.writeFile(outside, 'secret');

    const result = await run({ id: '../agent.db' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('not a saved-output id');
    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
  });

  it('says once when the agent is paging a saved output back into its context', async () => {
    const { id } = await writeToolOutput(lines(1000));
    const tools = getReadToolOutputTool({ userId: 'u1', agentId: 'a1', mode: 'heartbeat' });
    const tool = tools[READ_TOOL_OUTPUT_NAME] as {
      execute: (i: unknown, o: unknown) => Promise<ReadResult>;
    };

    for (let i = 0; i < 5; i++) await tool.execute({ id, offset: i * 10 + 1 }, {});

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('paging a saved result back'));
    expect(trackEvent).toHaveBeenCalledTimes(1);
    expect(trackEvent).toHaveBeenCalledWith(
      'tool output reread',
      'u1',
      expect.objectContaining({ 'invoke.mode': 'heartbeat' }),
    );
  });

  it('counts each saved output separately', async () => {
    const a = await writeToolOutput(lines(10));
    const b = await writeToolOutput(lines(10));
    const tools = getReadToolOutputTool({ userId: 'u1', agentId: 'a1', mode: 'chat' });
    const tool = tools[READ_TOOL_OUTPUT_NAME] as {
      execute: (i: unknown, o: unknown) => Promise<ReadResult>;
    };

    for (let i = 0; i < 2; i++) {
      await tool.execute({ id: a.id }, {});
      await tool.execute({ id: b.id }, {});
    }

    expect(warn).not.toHaveBeenCalled();
  });
});
