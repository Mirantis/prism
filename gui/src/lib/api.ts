/**
 * Read-only REST helpers for the runtime's `/agents/*` management endpoints,
 * used by the Overview page. Same no-auth, same-origin model as the chat
 * client — the Vite dev proxy forwards `/agents` to the runtime on :3003.
 *
 * Types mirror web/src/types.ts.
 */

import { httpUrl } from './runtime';

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(httpUrl(path));
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return (await res.json()) as T;
}

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
  model: string | null;
  status: 'RUNNING' | 'IDLE' | 'ERROR';
  lastHeartbeat: string | null;
  createdAt: string;
  updatedAt: string;
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
