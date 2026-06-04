/**
 * Read/write REST helpers for the runtime's `/agents/*` management endpoints,
 * used by the Overview, Channels, Scheduled Tasks, and Profile pages. Same
 * no-auth, same-origin model as the chat client — the Vite dev proxy forwards
 * `/agents` to the runtime on :3003.
 *
 * Types mirror web/src/types.ts.
 */

import { httpUrl } from './runtime';

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error || body.message || `${res.status} ${res.statusText}`;
  } catch {
    return `${res.status} ${res.statusText}`;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(httpUrl(path));
  if (!res.ok) throw new Error(await parseError(res));
  return (await res.json()) as T;
}

async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(httpUrl(path), {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(await parseError(res));
  // Some endpoints (DELETE) may return empty bodies.
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const apiPost = <T>(path: string, body?: unknown) => apiSend<T>('POST', path, body);
export const apiPatch = <T>(path: string, body?: unknown) => apiSend<T>('PATCH', path, body);
export const apiDelete = <T>(path: string) => apiSend<T>('DELETE', path);

/** Direct download URL for the agent backup export (used as an <a href>). */
export const httpUrlExport = () => httpUrl('/agents/export');

export interface AgentSummary {
  agentId: string;
  userId: string;
  name: string;
}

export interface AgentDetails {
  id: string;
  userId: string;
  name: string;
  agentType: string;
  soulMd: string | null;
  userMd: string | null;
  memoryMd: string | null;
  heartbeatMd: string | null;
  visionMd: string | null;
  agentMd: string | null;
  bootstrapMd: string | null;
  model: string | null;
  status: 'RUNNING' | 'IDLE' | 'ERROR';
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInfo {
  model: string;
}

export interface HeartbeatStatus {
  isActive: boolean;
  lastRun: string | null;
  isRunning: boolean;
  consecutiveErrors: number;
  nextRun?: string | null;
  intervalMs?: number | null;
}

export interface CronTask {
  id: string;
  name: string;
  schedule: string;
  instruction: string | null;
  isActive: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SlackWorkspace {
  teamId: string;
  teamName: string;
  botUserId: string;
}

export interface SlackLinkStatus {
  hasDmMapping: boolean;
  hasChannelMapping: boolean;
  slackUserId: string | null;
}

export interface SlackChannelMapping {
  id: string;
  channelId: string;
  channelName: string | null;
  agentName: string;
  linkedAt: string;
}

export interface SlackHeartbeatTrigger {
  id: string;
  agentId: string;
  userId: string;
  connectionId: string;
  slackChannelId: string;
  slackChannelName: string | null;
  isActive: boolean;
  throttleSeconds: number;
  lastTriggeredAt: string | null;
  createdAt: string;
  updatedAt: string;
}
