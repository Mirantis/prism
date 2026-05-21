/**
 * Channel Learning Queue
 *
 * Handles async processing of channel messages for passive learning.
 * The agent processes queued messages and uses memory_write to store
 * relevant observations.
 *
 * This is a simple in-memory implementation. For production, consider
 * using BullMQ with Redis for persistence and better scalability.
 */

// ============================================================================
// Types
// ============================================================================

import { logger } from '../logger';

export interface ChannelLearningJob {
  id: string;
  agentId: string;
  userId: string;
  channelId: string;
  channelName?: string;
  message: string;
  senderName?: string;
  timestamp: number;
  createdAt: Date;
}

export interface QueueStats {
  pending: number;
  processed: number;
  failed: number;
}

// ============================================================================
// Channel Learning Queue
// ============================================================================

class ChannelLearningQueue {
  private queue: ChannelLearningJob[] = [];
  private processing = false;
  private processedCount = 0;
  private failedCount = 0;
  private jobIdCounter = 0;

  /**
   * Add a message to the learning queue
   */
  async add(job: Omit<ChannelLearningJob, 'id' | 'createdAt'>): Promise<string> {
    const id = `clq-${++this.jobIdCounter}-${Date.now()}`;
    const fullJob: ChannelLearningJob = {
      ...job,
      id,
      createdAt: new Date(),
    };

    this.queue.push(fullJob);
    logger.info({ jobId: id }, '[ChannelLearning] Queued message: %s', id);

    // Trigger processing if not already running
    if (!this.processing) {
      this.processQueue();
    }

    return id;
  }

  /**
   * Get queue statistics
   */
  getStats(): QueueStats {
    return {
      pending: this.queue.length,
      processed: this.processedCount,
      failed: this.failedCount,
    };
  }

  /**
   * Get pending jobs (for debugging)
   */
  getPendingJobs(): ChannelLearningJob[] {
    return [...this.queue];
  }

  /**
   * Clear the queue (for testing)
   */
  clear(): void {
    this.queue = [];
  }

  /**
   * Process the queue in batches
   *
   * Groups messages by user/channel and processes them together
   * to reduce LLM calls and provide better context.
   */
  private async processQueue(): Promise<void> {
    if (this.processing) return;
    this.processing = true;

    try {
      while (this.queue.length > 0) {
        const batch = this.collectBatch();

        if (batch.length === 0) break;

        // Group by agentId so memory writes are scoped to the correct agent
        const byAgent = this.groupByAgent(batch);

        for (const [agentId, jobs] of Object.entries(byAgent)) {
          try {
            await this.processAgentBatch(agentId, jobs);
            this.processedCount += jobs.length;
          } catch (error) {
            logger.error({ err: error, agentId }, '[ChannelLearning] Failed to process batch for agent %s', agentId);
            this.failedCount += jobs.length;
          }
        }

        // Brief pause between batches to avoid overwhelming the system
        await this.sleep(1000);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Collect a batch of messages to process together
   * Limits batch size and age for timely processing
   */
  private collectBatch(): ChannelLearningJob[] {
    const maxBatchSize = 10;
    const maxAge = 5 * 60 * 1000; // 5 minutes
    const now = Date.now();

    const batch: ChannelLearningJob[] = [];
    const remaining: ChannelLearningJob[] = [];

    for (const job of this.queue) {
      const age = now - job.createdAt.getTime();

      if (batch.length < maxBatchSize || age > maxAge) {
        batch.push(job);
      } else {
        remaining.push(job);
      }
    }

    this.queue = remaining;
    return batch;
  }

  /**
   * Group jobs by agentId so downstream processing is scoped to the correct agent
   */
  private groupByAgent(jobs: ChannelLearningJob[]): Record<string, ChannelLearningJob[]> {
    const grouped: Record<string, ChannelLearningJob[]> = {};

    for (const job of jobs) {
      if (!grouped[job.agentId]) {
        grouped[job.agentId] = [];
      }
      grouped[job.agentId].push(job);
    }

    return grouped;
  }

  /**
   * Process a batch of messages for a single agent
   *
   * The agent analyzes the messages and decides what to store in memory.
   * We don't invoke the full conversation engine - instead, we could:
   * 1. Summarize the batch and store as an observation
   * 2. Or, in a more sophisticated implementation, let the agent decide
   *
   * For now, we just log and store high-level summaries.
   */
  private async processAgentBatch(agentId: string, jobs: ChannelLearningJob[]): Promise<void> {
    logger.info({ agentId, count: jobs.length }, '[ChannelLearning] Processing %d message(s) for agent %s', jobs.length, agentId);

    // Group by channel for better context
    const byChannel: Record<string, ChannelLearningJob[]> = {};
    for (const job of jobs) {
      if (!byChannel[job.channelId]) {
        byChannel[job.channelId] = [];
      }
      byChannel[job.channelId].push(job);
    }

    // For now, just log the activity
    // In a full implementation, we would:
    // 1. Build a summary of the messages
    // 2. Call memory.write with category "observation"
    // 3. Let the agent decide importance based on content

    for (const [channelId, channelJobs] of Object.entries(byChannel)) {
      const channelName = channelJobs[0].channelName || channelId;
      const messageCount = channelJobs.length;
      const participants = new Set(channelJobs.map(j => j.senderName).filter(Boolean));

      logger.info(
        { channelName, messageCount, participantCount: participants.size },
        '[ChannelLearning] Channel %s: %d message(s) from %d participant(s)',
        channelName, messageCount, participants.size
      );

      // TODO: Implement actual learning via memory service
      // Example:
      // const summary = await this.summarizeMessages(channelJobs);
      // await memoryService.write(agentId, {
      //   content: `Channel activity in ${channelName}: ${summary}`,
      //   category: 'observation',
      //   importance: this.calculateImportance(channelJobs),
      // });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton instance
export const channelLearningQueue = new ChannelLearningQueue();
