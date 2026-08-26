import { describe, expect, it } from 'vitest';
import {
  commandLogFromToolCalls,
  findUnbackedClaims,
} from '../completion-claims';

describe('commandLogFromToolCalls', () => {
  it('classifies write/edit/share/delete from tool names', () => {
    const log = commandLogFromToolCalls([
      { tool: 'shell_write_file', output: '{"ok":true}', success: true },
      { tool: 'shell_edit_file', output: '{"ok":true}', success: true },
      { tool: 'share_file', output: '{"success":true,"sizeBytes":12}', success: true },
      { tool: 'shell_exec', input: '{"command":"rm /tmp/a"}', output: '{"exitCode":0}', success: true },
    ]);
    expect(new Set(log.map((e) => e.kind))).toEqual(new Set(['delete', 'edit', 'share', 'write', 'read']));
  });

  it('marks failed tool output as unsuccessful', () => {
    const log = commandLogFromToolCalls([
      { tool: 'shell_write_file', output: '{"error":"EACCES"}', success: true },
    ]);
    expect(log[0].success).toBe(false);
  });
});

describe('findUnbackedClaims', () => {
  it('fails when a completion claim has no tool result', () => {
    const reply = 'I wrote the notes file at /data/prism-agent-notes/AGENT-166.md.';
    expect(findUnbackedClaims(reply, [])).toEqual([
      expect.objectContaining({ kind: 'completion' }),
    ]);
  });

  it('fails the 2026-08-25 fabricated deletion+verification', () => {
    const reply =
      'Both files are gone now (verified: only heartbeat.md left in /data/scratch/).';
    const v = findUnbackedClaims(reply, []);
    expect(v.some((x) => x.kind === 'completion')).toBe(true);
    expect(v.some((x) => x.kind === 'verification')).toBe(true);
  });

  it('passes when the same deletion is backed by rm + ls', () => {
    const reply =
      'Both files are gone now (verified: only heartbeat.md left in /data/scratch/).';
    const v = findUnbackedClaims(reply, [
      { tool: 'shell_exec', input: '{"command":"rm /data/scratch/a.md /data/scratch/b.md"}', output: '{"exitCode":0}' },
      { tool: 'shell_exec', input: '{"command":"ls /data/scratch"}', output: '{"stdout":"heartbeat.md\\n"}' },
    ]);
    expect(v).toEqual([]);
  });

  it('treats intent phrasing as not a completion claim', () => {
    const reply = "I will write that up rather than leave it as tribal knowledge.";
    expect(findUnbackedClaims(reply, [])).toEqual([]);
  });

  it('fails an edit described as applied with no tool', () => {
    const reply = 'dropped the scheduled-tasks bullet, rewrote the credentials section of the file';
    expect(findUnbackedClaims(reply, []).length).toBeGreaterThan(0);
  });

  it('passes an edit claim backed by shell_edit_file', () => {
    const reply = 'rewrote the credentials section of the file';
    expect(
      findUnbackedClaims(reply, [
        { tool: 'shell_edit_file', output: '{"ok":true}' },
      ]),
    ).toEqual([]);
  });
});
