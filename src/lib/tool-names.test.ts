/**
 * Tests for the model-facing tool name rule: the character set and length every
 * provider enforces, and the properties two independent callers depend on —
 * determinism (the tools-block prompt cache), distinctness (two long names that
 * share a prefix), and idempotence (the same function runs on the assembled tool
 * set and on names replayed from history).
 */
import { describe, it, expect } from 'vitest';
import type { Tool } from 'ai';

import { capToolNames, sanitizeToolNameSegment, toModelToolName, MAX_TOOL_NAME } from './tool-names';

/** The shape a provider will accept: this charset, within this length. */
const ACCEPTED = /^[A-Za-z0-9_-]{1,64}$/;

/** A Nexus MCP name from the failure this rule exists for (70 characters). */
const NEXUS_ATLASSIAN = '75166a14-fd0b-4bbb-b6d6-ddbd008bb95b__atlassian__addCommentToJiraIssue';

function makeTool(name: string): Tool {
  return { description: name, inputSchema: { type: 'object' } } as unknown as Tool;
}

describe('sanitizeToolNameSegment', () => {
  it('replaces anything outside the accepted charset', () => {
    expect(sanitizeToolNameSegment('read:file')).toBe('read_file');
    expect(sanitizeToolNameSegment('my.plugin')).toBe('my_plugin');
  });

  it('keeps a segment of pure punctuation contributing one stable token', () => {
    const a = sanitizeToolNameSegment('___');
    const b = sanitizeToolNameSegment('...');
    expect(a).toMatch(/^x[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
    expect(sanitizeToolNameSegment('___')).toBe(a);
  });
});

describe('toModelToolName', () => {
  it('leaves an ordinary name byte-identical', () => {
    for (const name of ['shell_exec', 'memory_search', 'Task', 'demo__probe__search']) {
      expect(toModelToolName(name)).toBe(name);
    }
  });

  it('sanitizes each segment and keeps the __ joiners intact', () => {
    // Sanitizing the joined string instead would collapse `__` to `_` and merge
    // the namespace into the tool's own name.
    expect(toModelToolName('my.plugin__srv__read:file')).toBe('my_plugin__srv__read_file');
  });

  it('prefixes a name that would start with a digit', () => {
    // JavaScript enumerates integer-like keys first regardless of insertion
    // order, which would reorder the tools block behind the cache's back.
    expect(toModelToolName('12306__srv__search')).toBe('t_12306__srv__search');
  });

  it('shortens the over-long Nexus name that a provider rejects', () => {
    const capped = toModelToolName(NEXUS_ATLASSIAN);

    expect(NEXUS_ATLASSIAN.length).toBe(70);
    expect(capped).toBe('t_75166a14-fd0b-4bbb-b6d6-ddbd008bb95b__atlassian__addCo_b897e9d');
    expect(capped.length).toBe(MAX_TOOL_NAME);
    expect(capped).toMatch(ACCEPTED);
  });

  it('keeps two over-long names distinct when they share a prefix', () => {
    const long = 'a'.repeat(70);
    const a = toModelToolName(`${long}_one`);
    const b = toModelToolName(`${long}_two`);

    expect(a).not.toBe(b);
    expect(a.length).toBe(MAX_TOOL_NAME);
    expect(b.length).toBe(MAX_TOOL_NAME);
  });

  it('is stable across calls, so the tools block survives a restart', () => {
    expect(toModelToolName(NEXUS_ATLASSIAN)).toBe(toModelToolName(NEXUS_ATLASSIAN));
  });

  it('is idempotent', () => {
    // What lets the assembled tool set and a name replayed from history go
    // through the same function and still agree.
    const names = [
      NEXUS_ATLASSIAN,
      'a'.repeat(200),
      'x__'.repeat(30),
      'shell_exec',
      // The truncation lands on a whole `__` joiner. Without the trailing-
      // underscore strip the result holds a run of three, which the next pass
      // would collapse — so this fixture is what proves the strip load-bearing.
      `${'a'.repeat(54)}__${'b'.repeat(20)}`,
      // …and one character either side of that boundary.
      `${'a'.repeat(53)}__${'b'.repeat(20)}`,
      `${'a'.repeat(55)}__${'b'.repeat(20)}`,
    ];
    for (const name of names) {
      const once = toModelToolName(name);
      expect(toModelToolName(once)).toBe(once);
      expect(once).toMatch(ACCEPTED);
    }
  });

  it('never emits a name a provider would reject', () => {
    const names = [
      NEXUS_ATLASSIAN,
      'a'.repeat(500),
      '...',
      '9',
      'server..name__tool with spaces',
      '__leading__and__trailing__',
      'ünïcödé__tööl',
    ];
    for (const name of names) {
      expect(toModelToolName(name)).toMatch(ACCEPTED);
    }
  });
});

describe('capToolNames', () => {
  it('is a no-op when every name already fits', () => {
    const tools = { shell_exec: makeTool('shell_exec'), memory_search: makeTool('memory_search') };
    const capped = capToolNames(tools, 'test');

    expect(Object.keys(capped)).toEqual(['shell_exec', 'memory_search']);
    expect(capped.shell_exec).toBe(tools.shell_exec);
  });

  it('renames only what does not fit', () => {
    const other = `${'b'.repeat(60)}__tool`;
    const capped = capToolNames(
      { shell_exec: makeTool('shell_exec'), [NEXUS_ATLASSIAN]: makeTool('mcp'), [other]: makeTool('other') },
      'test',
    );

    expect(Object.keys(capped)).toHaveLength(3);
    for (const name of Object.keys(capped)) expect(name).toMatch(ACCEPTED);
    expect(capped[toModelToolName(NEXUS_ATLASSIAN)].description).toBe('mcp');
  });

  it('preserves insertion order, which the cache breakpoint rides on', () => {
    const capped = capToolNames(
      {
        shell_exec: makeTool('shell_exec'),
        [NEXUS_ATLASSIAN]: makeTool('mcp'),
        memory_search: makeTool('memory_search'),
        Task: makeTool('Task'),
      },
      'test',
    );

    expect(Object.keys(capped)).toEqual([
      'shell_exec',
      toModelToolName(NEXUS_ATLASSIAN),
      'memory_search',
      'Task',
    ]);
  });

  it('keeps the incumbent when a sanitized name lands on one already taken', () => {
    const capped = capToolNames(
      { shell_exec: makeTool('built-in'), 'shell.exec': makeTool('remote') },
      'test',
    );

    expect(Object.keys(capped)).toEqual(['shell_exec']);
    expect(capped.shell_exec.description).toBe('built-in');
  });

  it('drops a rename that lands on a reserved name, whatever the arrival order', () => {
    // `Task` is added after the MCP maps merge, so it arrives last and first-wins
    // would protect the remote tool instead of it.
    const capped = capToolNames(
      { 'Task.': makeTool('remote'), Task: makeTool('the real one') },
      'test',
      new Set(['Task']),
    );

    expect(Object.keys(capped)).toEqual(['Task']);
    expect(capped.Task.description).toBe('the real one');
  });

  it('leaves a reserved name alone when the tool that owns it is the one being capped', () => {
    const capped = capToolNames({ shell_exec: makeTool('built-in') }, 'test', new Set(['shell_exec']));

    expect(capped.shell_exec.description).toBe('built-in');
  });

  it('refuses a rename into a name no longer in the set — a mode withheld it', () => {
    // The slot is empty rather than free: `share_file` was filtered out for this
    // mode, and a remote tool sanitizing into it would hand the model back a
    // capability the mode took away.
    const capped = capToolNames(
      { 'share.file': makeTool('remote'), kubectl: makeTool('kubectl') },
      'test',
      new Set(['share_file']),
    );

    expect(Object.keys(capped)).toEqual(['kubectl']);
  });
});
