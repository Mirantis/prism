/**
 * WebSocket Gateway Service
 *
 * Provides real-time bidirectional communication for the personal agent.
 * Supports three message modes:
 * - steer: Interrupt agent mid-turn (urgent)
 * - followup: Queued messages, processed in order
 * - collect: Batched messages before processing
 */

import { Server as HttpServer } from 'http';
import WebSocket, { WebSocketServer } from 'ws';
import { IncomingMessage } from 'http';
import { logger } from '../logger';
import { config } from '../config';
import { conversationEngineService } from './conversation-engine.service';

// ============================================================================
// Types
// ============================================================================

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  userToken?: string;
  isAlive?: boolean;
}

interface WebSocketMessage {
  type: 'chat' | 'ping' | 'pong' | 'subscribe';
  mode?: 'steer' | 'followup' | 'collect';
  content?: string;
  threadId?: string;
  // Optional in single-agent mode: the runtime substitutes `config.agentId`
  // when omitted. Multi-tenant clients must still send it.
  agentId?: string;
}

interface WebSocketResponse {
  type: 'chat' | 'pong' | 'error' | 'status';
  threadId?: string;
  messageId?: string;
  content?: string;
  toolCalls?: unknown[];
  blocks?: unknown[];
  payload?: unknown;
}

// ============================================================================
// WebSocket Gateway Service
// ============================================================================

class WebSocketGatewayService {
  private wss: WebSocketServer | null = null;
  private connections: Map<string, AuthenticatedWebSocket[]> = new Map();
  private messageQueues: Map<string, Array<{ message: WebSocketMessage; resolve: (response: WebSocketResponse) => void }>> = new Map();
  private processingUsers: Set<string> = new Set();

  /**
   * Initialize WebSocket server
   */
  initialize(server: HttpServer): void {
    this.wss = new WebSocketServer({
      server,
      path: '/api/ws',
    });

    this.wss.on('connection', (ws: AuthenticatedWebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });

    // Heartbeat to detect dead connections
    const interval = setInterval(() => {
      this.wss?.clients.forEach((ws: AuthenticatedWebSocket) => {
        if (ws.isAlive === false) {
          return ws.terminate();
        }
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);

    this.wss.on('close', () => {
      clearInterval(interval);
    });

    logger.info('WebSocket gateway initialized on /api/ws');
  }

  /**
   * Handle new connection
   */
  private handleConnection(ws: AuthenticatedWebSocket, req: IncomingMessage): void {
    ws.isAlive = true;

    // The runtime is scoped to one agent and trusts the inbound network
    // (Nexus routing terminates auth in front of the container). Pin the
    // connection to the configured owner without inspecting a token.
    const userId: string = config.ownerUserId;
    ws.userId = userId;

    // Store connection
    const userConnections = this.connections.get(userId) || [];
    userConnections.push(ws);
    this.connections.set(userId, userConnections);

    logger.info('WebSocket connected for user %s (%d connections)', userId, userConnections.length);

    // Handle messages
    ws.on('message', async (data: Buffer) => {
      try {
        const message: WebSocketMessage = JSON.parse(data.toString());
        await this.handleMessage(ws, userId, message);
      } catch (error: unknown) {
        logger.error('WebSocket message error: %s', error instanceof Error ? error.message : String(error));
        ws.send(JSON.stringify({ type: 'error', payload: { error: error instanceof Error ? error.message : String(error) } }));
      }
    });

    // Handle pong
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    // Handle errors
    ws.on('error', (error) => {
      logger.error('WebSocket error for user %s: %s', userId, error instanceof Error ? error.message : String(error));
    });

    // Handle close
    ws.on('close', (code, _reason) => {
      this.removeConnection(userId, ws);
      logger.info('WebSocket disconnected for user %s - code: %d', userId, code);
    });

    // Send initial connection status
    ws.send(JSON.stringify({
      type: 'status',
      payload: { connected: true },
    }));

  }

  /**
   * Handle incoming message
   */
  private async handleMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    logger.info('WebSocket message received from %s', userId);

    switch (message.type) {
      case 'ping':
      case 'pong':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'chat':
        await this.handleChatMessage(ws, userId, message);
        break;

      case 'subscribe':
        // User is subscribing to notifications (already connected)
        break;

      default:
        logger.warn('Unknown WebSocket message type: %s', message.type);
        ws.send(JSON.stringify({ type: 'error', payload: { error: 'Unknown message type' } }));
    }
  }

  /**
   * Handle chat message based on mode
   */
  private async handleChatMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    // Handle both flat format and nested payload format (frontend uses payload)
    const payload = (message as any).payload || message;
    const mode = payload.mode || message.mode || 'followup';
    const content = payload.content || message.content || '';
    const threadId = payload.threadId || message.threadId;
    // The runtime knows the one agent it serves, so the client can omit
    // `agentId` from the wire (the prism-cli does). Substitute here before
    // validation so downstream code sees a fully-populated message.
    const agentId = payload.agentId || message.agentId || config.agentId;
    if (!agentId) {
      ws.send(JSON.stringify({
        type: 'error',
        payload: { error: 'Agent runtime is still initializing; retry shortly' },
      }));
      return;
    }

    logger.info('Chat message from %s: mode=%s', userId, mode);

    if (!content.trim()) {
      logger.warn('Empty message from %s', userId);
      ws.send(JSON.stringify({ type: 'error', payload: { error: 'Empty message' } }));
      return;
    }

    // Update message with extracted values for downstream processing
    message.mode = mode;
    message.content = content;
    message.threadId = threadId;
    message.agentId = agentId;

    switch (mode) {
      case 'steer':
        // Steer mode: Interrupt agent (for now, treat as followup)
        // TODO: Implement actual interruption
        await this.processMessage(ws, userId, message);
        break;

      case 'followup':
        // Followup mode: Queue and process in order
        await this.queueMessage(ws, userId, message);
        break;

      case 'collect':
        // Collect mode: Batch messages (for now, treat as followup)
        // TODO: Implement batching
        await this.queueMessage(ws, userId, message);
        break;

      default:
        await this.queueMessage(ws, userId, message);
    }
  }

  /**
   * Queue message for processing
   */
  private async queueMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    // If not processing, process immediately
    if (!this.processingUsers.has(userId)) {
      await this.processMessage(ws, userId, message);
      return;
    }

    // Otherwise queue it
    const queue = this.messageQueues.get(userId) || [];
    queue.push({
      message,
      resolve: (response) => ws.send(JSON.stringify(response)),
    });
    this.messageQueues.set(userId, queue);
  }

  /**
   * Process a message through the backend's conversation engine
   */
  private async processMessage(
    ws: AuthenticatedWebSocket,
    userId: string,
    message: WebSocketMessage
  ): Promise<void> {
    const agentId = message.agentId;
    if (!agentId) {
      ws.send(JSON.stringify({ type: 'error', payload: { error: 'Agent ID is required in the message' } }));
      return;
    }

    // Authorization: Nexus inbound routing terminates auth in front of the
    // runtime. Once a request reaches the container we trust the connection.
    // Still pin to *this* container's agent so a stray client can't address
    // another runtime.
    if (agentId !== config.agentId) {
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: { error: 'Forbidden: this runtime serves a different agent' },
        })
      );
      return;
    }

    logger.info('Processing message for %s', userId);
    this.processingUsers.add(userId);

    try {
      // Send processing indicator
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'status',
          payload: { processing: true },
        }));
      }

      logger.info('Calling conversation engine for %s', userId);

      // Process through local conversation engine (direct call, no HTTP)
      await conversationEngineService.chat({
        userId,
        agentId,
        message: message.content || '',
        threadId: message.threadId,
        metadata: { channel: 'websocket' },
      });

      logger.info('Conversation engine completed for %s', userId);

      // Note: Response delivery is handled by messageDeliveryService.publish()
      // which is called by conversationEngineService.chat() - no manual sending needed
    } catch (error: unknown) {
      logger.error('Error processing message: %s', error instanceof Error ? error.message : String(error));
      ws.send(JSON.stringify({
        type: 'error',
        payload: { error: error instanceof Error ? error.message : String(error) },
      }));
    } finally {
      this.processingUsers.delete(userId);

      // Process queued messages
      await this.processQueue(userId);
    }
  }

  /**
   * Process queued messages
   */
  private async processQueue(userId: string): Promise<void> {
    const queue = this.messageQueues.get(userId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift();
    if (!next) return;

    const connections = this.connections.get(userId);
    const ws = connections?.[0];
    if (ws) {
      await this.processMessage(ws, userId, next.message);
    }
  }

  /**
   * Broadcast to all connections for a user
   */
  broadcast(userId: string, message: WebSocketResponse): void {
    const connections = this.connections.get(userId);
    if (!connections) return;

    connections.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
      }
    });
  }

  /**
   * Extract user ID from request by decoding the JWT token.
   * Backend already verified the signature — we only decode here.
   */
  private extractUserAuth(req: IncomingMessage): { userId: string; token: string } | null {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    let token = url.searchParams.get('token');

    if (!token) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        token = authHeader.substring(7);
      }
    }

    // Nexus inbound routing terminates auth in front of the runtime, so we
    // trust the connection here. The Web UI talks straight to the runtime
    // over WS without a JWT — fall back to the bootstrap-default owner user
    // (matches the agent's `userId`).
    if (!token) {
      return { userId: config.ownerUserId, token: '' };
    }

    try {
      // Decode only — backend already verified the signature
      const parts = token.split('.');
      if (parts.length !== 3) return null;
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      if (!decoded?.sub) return null;
      return { userId: decoded.sub, token };
    } catch {
      logger.error('Failed to decode JWT token');
      return null;
    }
  }

  /**
   * Remove connection from tracking
   */
  private removeConnection(userId: string, ws: AuthenticatedWebSocket): void {
    const connections = this.connections.get(userId);
    if (!connections) return;

    const index = connections.indexOf(ws);
    if (index > -1) {
      connections.splice(index, 1);
    }

    if (connections.length === 0) {
      this.connections.delete(userId);
    } else {
      this.connections.set(userId, connections);
    }
  }

  /**
   * Get connection count for a user
   */
  getConnectionCount(userId: string): number {
    return this.connections.get(userId)?.length || 0;
  }

  /**
   * Check if user is connected
   */
  isConnected(userId: string): boolean {
    return this.getConnectionCount(userId) > 0;
  }

  /**
   * Close all connections (for shutdown)
   */
  closeAll(): void {
    this.wss?.clients.forEach((ws) => {
      ws.close(1001, 'Server shutting down');
    });
    this.connections.clear();
  }
}

// Export singleton instance
export const webSocketGatewayService = new WebSocketGatewayService();
