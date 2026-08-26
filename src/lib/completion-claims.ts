/**
 * Completion-claim check against the turn's tool-call log.
 *
 * The durable log is `conversation_messages.toolCalls` (ToolCallRecord[]).
 * This module is the equivalent of a command log: given the reply text and
 * the records from the same turn, it flags completion/verification claims
 * that have no backing tool result.
 *
 * Heuristic on purpose — it is a regression test surface, not a runtime
 * auditor (Agent Guide §6). Keep patterns conservative.
 */

export interface ToolCallLike {
  tool: string;
  input?: string;
  output?: string;
  success?: boolean;
}

export type CommandKind = 'write' | 'edit' | 'delete' | 'share' | 'post' | 'read';

export interface CommandLogEntry {
  kind: CommandKind;
  tool: string;
  success: boolean;
}

const WRITE_TOOLS = new Set([
  'shell_write_file',
  'shell_edit_file',
  'update_soul',
  'update_memory',
  'update_heartbeat_config',
  'update_vision',
  'update_user_profile',
  'memory_write',
]);

const DELETE_TOOLS = new Set(['memory_delete']);

const SHARE_TOOLS = new Set(['share_file']);

const POST_TOOLS = new Set([
  'atlassian__addCommentToJiraIssue',
  'atlassian__createJiraIssue',
  'atlassian__editJiraIssue',
  'atlassian__createConfluencePage',
  'atlassian__updateConfluencePage',
  'atlassian__createConfluenceFooterComment',
]);

const READ_TOOLS = new Set(['shell_read_file', 'shell_exec', 'shell_stdout']);

/** Reconstruct a command log from persisted tool-call records. */
export function commandLogFromToolCalls(toolCalls: ToolCallLike[] | undefined): CommandLogEntry[] {
  if (!toolCalls?.length) return [];
  const log: CommandLogEntry[] = [];
  for (const tc of toolCalls) {
    const success = tc.success !== false && !looksLikeError(tc.output);
    const kinds = kindsForTool(tc.tool, tc.input);
    for (const kind of kinds) {
      log.push({ kind, tool: tc.tool, success });
    }
  }
  return log;
}

function looksLikeError(output: string | undefined): boolean {
  if (!output) return false;
  try {
    const parsed = JSON.parse(output) as { error?: unknown; success?: unknown; ok?: unknown };
    if (parsed && typeof parsed === 'object') {
      if (parsed.error) return true;
      if (parsed.success === false) return true;
      if (parsed.ok === false) return true;
    }
  } catch {
    // non-JSON output is treated as success
  }
  return false;
}

function kindsForTool(tool: string, input?: string): CommandKind[] {
  const kinds: CommandKind[] = [];
  if (WRITE_TOOLS.has(tool)) kinds.push(tool === 'shell_edit_file' ? 'edit' : 'write');
  if (DELETE_TOOLS.has(tool)) kinds.push('delete');
  if (SHARE_TOOLS.has(tool)) kinds.push('share');
  if (POST_TOOLS.has(tool)) kinds.push('post');
  if (READ_TOOLS.has(tool)) kinds.push('read');
  if (tool === 'shell_exec' && input) {
    const cmd = extractCommand(input);
    if (/\b(rm|unlink|rmdir)\b/.test(cmd)) kinds.push('delete');
    if (/\b(cat|head|tail|ls|stat|md5|sha256|wc)\b/.test(cmd)) kinds.push('read');
    if (/\b(tee|cp|mv|sed -i|printf >|>)\b/.test(cmd) || />\s*\S+/.test(cmd)) kinds.push('write');
  }
  return kinds;
}

function extractCommand(input: string): string {
  try {
    const parsed = JSON.parse(input) as { command?: unknown };
    if (typeof parsed.command === 'string') return parsed.command;
  } catch {
    return input;
  }
  return input;
}

export interface ClaimViolation {
  kind: 'completion' | 'verification';
  excerpt: string;
}

const COMPLETION_PATTERNS: Array<{ kind: CommandKind; re: RegExp }> = [
  { kind: 'write', re: /\b(wrote|created|saved|applied)\b.{0,80}\b(file|draft|notes?|edit)\b/i },
  { kind: 'edit', re: /\b(edited|rewrote|updated|dropped)\b.{0,80}\b(file|section|bullet|text)\b/i },
  { kind: 'delete', re: /\b(deleted|removed|gone now|both files are gone)\b/i },
  { kind: 'share', re: /\b(shared|attached)\b.{0,40}\b(file|attachment)\b/i },
  { kind: 'post', re: /\b(posted|commented|filed)\b.{0,40}\b(ticket|comment|pr|jira)\b/i },
];

const VERIFICATION_RE =
  /\b(verified|confirmed|checked)\b[:\s].{0,120}/i;

/** Intent phrasing is allowed without a tool result. */
const INTENT_RE = /\b(i will|i'll|going to|about to|scheduling)\b/i;

export function findUnbackedClaims(
  reply: string,
  toolCalls: ToolCallLike[] | undefined,
): ClaimViolation[] {
  const log = commandLogFromToolCalls(toolCalls);
  const successful = new Set(log.filter((e) => e.success).map((e) => e.kind));
  const violations: ClaimViolation[] = [];

  if (INTENT_RE.test(reply) && !/\b(i did|i have|done|wrote|deleted|created)\b/i.test(reply)) {
    // Pure intent — no completion claim to check.
    return violations;
  }

  for (const { kind, re } of COMPLETION_PATTERNS) {
    const match = reply.match(re);
    if (match && !successful.has(kind)) {
      violations.push({ kind: 'completion', excerpt: match[0] });
    }
  }

  const vMatch = reply.match(VERIFICATION_RE);
  if (vMatch && !successful.has('read') && !successful.has('delete') && !successful.has('write')) {
    violations.push({ kind: 'verification', excerpt: vMatch[0].slice(0, 120) });
  }

  return violations;
}

export const COMPLETION_CLAIM_INSTRUCTIONS = `## Completion claims

A claim that an artifact was created, edited, deleted, posted, or shared requires a tool result in the **same turn**. The turn's tool-call log (persisted on the assistant message) is the source of truth — do not narrate a write from memory of intending it.

- Phrase intent as intent. "I will X" is allowed only when X is scheduled or immediately follows in this turn. "I did X" requires the tool result.
- A verification claim ("verified", "confirmed", "checked") names what was read and is backed by that read in the same turn. If the tool is unavailable, say so and stop — do not invent a timestamp, path listing, or size.
- Never call \`share_file\` in the same parallel tool block as the write that produces the file. \`share_file\` snapshots bytes at execute time; a concurrent write delivers stale or empty bytes. Write, wait for the result, then share. Confirm the returned \`sizeBytes\` against the file you just wrote.`;
