/**
 * Backend Client
 *
 * Typed HTTP client for calling the backend's internal REST API.
 * Used by agent-runtime for access control checks and SlackConnection CRUD
 * (SlackConnection data lives in the backend-only database).
 *
 * Agent data operations (CRUD, tokens, subagents) are handled locally
 * by agentCrudService — not via this client.
 */

import { config } from '../config';
import { logger } from '../logger';

// ============================================================================
// Types
// ============================================================================

export interface SlackConnectionRecord {
  id: string;
  teamId: string;
  teamName: string;
  botToken: string;
  botUserId: string;
  installedAt: string;
  isActive: boolean;
}

// ============================================================================
// Client
// ============================================================================

class BackendClient {
  private baseUrl: string;
  private secret: string;

  constructor() {
    this.baseUrl = `${config.backendUrl}/internal/api`;
    this.secret = config.internalApiSecret || '';
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${this.secret}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errorBody = await res.text();
      throw new Error(`Backend API ${method} ${path} failed (${res.status}): ${errorBody}`);
    }

    return res.json() as Promise<T>;
  }

  // ============================================================================
  // Access Control
  // ============================================================================

  /**
   * Check if a user can access an agent (owner, team member, or org admin).
   * Delegates to the backend which has the Nexus client for org/team lookups.
   */
  async canAccessAgent(agentId: string, userId: string, userToken?: string): Promise<boolean> {
    try {
      const { allowed } = await this.request<{ allowed: boolean }>('POST', '/can-access-agent', {
        agentId,
        userId,
        userToken,
      });
      return allowed;
    } catch {
      return false;
    }
  }

  // ============================================================================
  // SlackConnection Endpoints
  // ============================================================================

  async getActiveSlackConnections(): Promise<SlackConnectionRecord[]> {
    const { connections } = await this.request<{ connections: SlackConnectionRecord[] }>(
      'GET', '/slack-connections?active=true'
    );
    return connections;
  }

  async getSlackConnection(id: string): Promise<SlackConnectionRecord | null> {
    try {
      const { connection } = await this.request<{ connection: SlackConnectionRecord }>(
        'GET', `/slack-connections/${id}`
      );
      return connection;
    } catch (error) {
      // 404 means not found
      if (error instanceof Error && error.message.includes('(404)')) {
        return null;
      }
      throw error;
    }
  }

  // ============================================================================
  // Health Check
  // ============================================================================

  async waitForBackend(maxRetries: number = 30, intervalMs: number = 2000): Promise<void> {
    for (let i = 0; i < maxRetries; i++) {
      try {
        const res = await fetch(`${config.backendUrl}/health`);
        if (res.ok) {
          logger.info('[BackendClient] Backend is available');
          return;
        }
      } catch {
        // Backend not ready yet
      }
      if (i < maxRetries - 1) {
        logger.info(`[BackendClient] Waiting for backend... (${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, intervalMs));
      }
    }
    throw new Error(`Backend not available after ${maxRetries} retries`);
  }
}

// Export singleton
export const backendClient = new BackendClient();
