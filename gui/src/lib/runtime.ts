/**
 * Agent-runtime client helpers for the desktop GUI.
 *
 * Like the prism-cli, the GUI is a local client that talks to the runtime
 * directly with no auth — the runtime owns the one agent and substitutes
 * `agentId`/`userId`/`threadId` server-side when our messages omit them.
 *
 * URLs default to same-origin so the Vite dev proxy (see vite.config.ts)
 * forwards `/single-agent` and `/api/ws` to the runtime on :3003. Set
 * `VITE_RUNTIME_URL` (e.g. http://localhost:3003) to point a packaged build
 * at a runtime directly.
 */

const RUNTIME_URL = (import.meta.env.VITE_RUNTIME_URL ?? '').replace(/\/$/, '');

export function httpUrl(path: string): string {
  return `${RUNTIME_URL}${path}`;
}

export function webSocketUrl(): string {
  if (RUNTIME_URL) {
    return RUNTIME_URL.replace(/^http/, 'ws') + '/api/ws';
  }
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/ws`;
}

export type MessageRole = 'USER' | 'AGENT' | 'SYSTEM';

export interface ToolCallRecord {
  tool: string;
  input: string;
  output: string;
  success: boolean;
  timestamp?: string;
}

export interface ConversationMessage {
  id: string;
  threadId: string;
  role: MessageRole;
  content: string;
  triggeredBy: string;
  toolCalls: ToolCallRecord[] | null;
  blocks: unknown[] | null;
  createdAt: string;
}

/** Loosely validate a wire/REST message into a ConversationMessage. */
export function coerceMessage(raw: unknown): ConversationMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (typeof m.id !== 'string' || typeof m.content !== 'string') return null;
  const role: MessageRole =
    m.role === 'USER' || m.role === 'AGENT' || m.role === 'SYSTEM' ? m.role : 'AGENT';
  return {
    id: m.id,
    threadId: typeof m.threadId === 'string' ? m.threadId : '',
    role,
    content: m.content,
    triggeredBy: typeof m.triggeredBy === 'string' ? m.triggeredBy : 'USER_INPUT',
    toolCalls: Array.isArray(m.toolCalls) ? (m.toolCalls as ToolCallRecord[]) : null,
    blocks: Array.isArray(m.blocks) ? m.blocks : null,
    createdAt: typeof m.createdAt === 'string' ? m.createdAt : new Date().toISOString(),
  };
}

/**
 * Replay the active thread's recent messages. Hits the runtime's no-auth
 * `/single-agent/messages` endpoint; returns [] on any failure (e.g. runtime
 * down) so the UI renders an empty conversation rather than blocking.
 */
export async function loadHistory(limit = 50): Promise<ConversationMessage[]> {
  try {
    const res = await fetch(httpUrl(`/single-agent/messages?limit=${limit}`));
    if (!res.ok) return [];
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body)) return [];
    return body
      .map(coerceMessage)
      .filter((m): m is ConversationMessage => m !== null);
  } catch {
    return [];
  }
}
