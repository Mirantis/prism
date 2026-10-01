import express from 'express';
import { createServer, type Server } from 'node:http';
import { config } from '../config';
import { logger } from '../logger';
import { captureRawBody } from '../lib/raw-body';
import { prisma } from '../lib/prisma';
import { trackEvent } from '../lib/telemetry';
import { webhookRouter } from '../routes/webhook';
import { agentWorkspaceService } from './agent-workspace.service';

/** The webhook listener serves deliveries on their own port. */
export function createWebhookApp() {
  const app = express();
  app.use(express.json({ limit: '5mb', verify: captureRawBody }));
  app.use('/agents', webhookRouter);
  return app;
}

export class WebhookReceiverService {
  private readonly server: Server = createServer(createWebhookApp());
  private pending: Promise<unknown> = Promise.resolve();
  private stopping = false;

  get enabled(): boolean {
    return this.server.listening;
  }

  /** Restore the saved receiver state before the management API starts. */
  async initialize(): Promise<void> {
    const agent = await agentWorkspaceService.getAgent();
    if (!agent.webhooksEnabled) return;
    try {
      await this.start();
    } catch (error) {
      trackEvent('webhook receiver toggle failed', agent.userId, {
        'agent.id': agent.id,
        'webhook.operation': 'startup',
      });
      logger.error({ err: error }, '[Webhook] Receiver could not start; restart to retry');
    }
  }

  setEnabled(enabled: boolean): Promise<void> {
    return this.enqueue(async () => {
      if (this.stopping) throw new Error('Webhook receiver is shutting down');
      const agent = await agentWorkspaceService.getAgent();
      try {
        await this.applyEnabled(agent.id, enabled);
        trackEvent('webhook receiver toggled', agent.userId, {
          'agent.id': agent.id,
          'webhook.receiver_enabled': String(enabled),
        });
      } catch (error) {
        trackEvent('webhook receiver toggle failed', agent.userId, {
          'agent.id': agent.id,
          'webhook.operation': enabled ? 'enable' : 'disable',
        });
        throw error;
      }
    });
  }

  shutdown(): Promise<void> {
    this.stopping = true;
    return this.enqueue(() => this.stop());
  }

  /** Serialize socket changes and their saved state across concurrent requests. */
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.pending.then(action);
    this.pending = result.catch(() => undefined);
    return result;
  }

  private async applyEnabled(agentId: string, enabled: boolean): Promise<void> {
    if (!enabled) {
      // Close the delivery gate before terminating existing connections.
      await prisma.agentWorkspace.update({
        where: { id: agentId },
        data: { webhooksEnabled: false },
      });
      await this.stop();
      return;
    }
    await this.start();
    try {
      await prisma.agentWorkspace.update({
        where: { id: agentId },
        data: { webhooksEnabled: true },
      });
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  private async start(): Promise<void> {
    if (this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        this.server.off('listening', onListening);
        const reason = error.code === 'EADDRINUSE'
          ? 'The port is already in use. Choose a free WEBHOOK_PORT and restart.'
          : error.message;
        reject(new Error(`Cannot enable webhooks on port ${config.webhookPort}. ${reason}`));
      };
      const onListening = () => {
        this.server.off('error', onError);
        resolve();
      };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(config.webhookPort, config.host);
    });
    logger.info({ port: config.webhookPort, host: config.host }, '[Webhook] Receiver enabled');
  }

  private async stop(): Promise<void> {
    if (!this.server.listening) return;
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error ? reject(error) : resolve());
      this.server.closeAllConnections();
    });
    logger.info('[Webhook] Receiver disabled');
  }
}

export const webhookReceiverService = new WebhookReceiverService();
