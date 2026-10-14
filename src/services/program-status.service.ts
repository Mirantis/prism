/**
 * Program Status Service
 *
 * Owns the agent's state as the runtime reports it on its stdout with OSC 7501
 * (`lib/program-status.ts`), so that a supervisor that reads the runtime's output,
 * such as LNS in a sandbox, can tell the user when the agent waits for them, has
 * finished or has failed. `PRISM_PROGRAM_STATUS` turns the reports on or off, and
 * without it the runtime reports when stdout is a terminal.
 *
 * A waiting computer help request wins over work, and work wins over how the last
 * work ended. Work is a turn on any thread, a conversation's whole exchange, a goal's
 * loop, and a compaction that is queued or running. When the work ends, the report is
 * `error` when a turn or an exchange failed, `idle` when one of them or a goal's loop was
 * cancelled, `done` when the agent delivered a reply, and `idle` otherwise: a heartbeat
 * or a scheduled task whose result was suppressed has nothing new to show.
 */

import type { ConversationMessage } from '@prisma/client';
import prisma from '../lib/prisma';
import { config } from '../config';
import { logger } from '../logger';
import { CLEAR_SEQUENCE, programStatusSequence, type ProgramStatus } from '../lib/program-status';
import { TURN_FAILED, type TurnEventPayload } from '../protocol/chat-protocol';
import { conversationThreadActivityService } from './conversation-thread-activity.service';
import { compactionService } from './compaction.service';
import { messageDeliveryService } from './message-delivery.service';
import { eventStreamService } from './event-stream.service';
import { computerService } from './computer/computer.service';
import { computerHelpService, type ComputerHelp } from './computer/computer-help.service';

/** How a turn ended: the error a person reads when it failed, or that it was stopped. */
export interface TurnEnding {
  error?: string;
  cancelled?: boolean;
}

/** How the current work, or the work that ended last, went. */
interface Outcome {
  error: string | null;
  cancelled: boolean;
  delivered: boolean;
}

const noOutcome = (): Outcome => ({ error: null, cancelled: false, delivered: false });

/** A help request's card asks the user for something, which the waiting request reports. */
const isHelpCard = (message: ConversationMessage): boolean =>
  Array.isArray(message.blocks) && (message.blocks[0] as { type?: unknown } | null)?.type === 'computer_help';

class ProgramStatusService {
  private agent: { id: string; userId: string } | null = null;
  private turns = 0;
  private work: 'turn' | 'compaction' | null = null;
  private outcome = noOutcome();
  /** The help request that waits for the user and was listed last, as last read. */
  private help: ComputerHelp | undefined;
  private helpChanged = true;
  private written: string | null = null;
  // One report is built at a time, and a change during the build schedules one more,
  // so the last report written is the newest state.
  private refreshing = false;
  private changedAgain = false;

  /** Start reporting for the agent, when reports are on. Ends with `clear` at process exit. */
  start(agentId: string, userId: string): void {
    if (!config.programStatusReports || this.agent) return;
    this.agent = { id: agentId, userId };
    conversationThreadActivityService.events.on('change', () => this.update());
    compactionService.events.on('compaction', () => this.update());
    compactionService.events.on('settled', () => this.update());
    messageDeliveryService.events.on('published', (message: ConversationMessage) => {
      if (isHelpCard(message)) return;
      this.outcome.delivered = true;
      this.update();
    });
    // A conversation's exchange can fail after its turns ended, when its reply cannot be stored.
    eventStreamService.subscribe(({ event }) => {
      if (event.type === 'turn') this.endExchange(event.payload);
    });
    computerService.access.on('change', () => {
      this.helpChanged = true;
      this.update();
    });
    process.once('exit', () => process.stdout.write(CLEAR_SEQUENCE));
    this.update();
  }

  /** Mark a turn as work. `end` says how the turn ended, once. */
  beginTurn(): { end(ending: TurnEnding): void } {
    this.turns++;
    this.update();
    let ended = false;
    return {
      end: ({ error, cancelled }) => {
        if (ended) return;
        ended = true;
        this.turns--;
        if (error) this.outcome.error = error;
        if (cancelled) this.outcome.cancelled = true;
        this.update();
      },
    };
  }

  private endExchange({ outcome, error }: TurnEventPayload): void {
    if (outcome === 'failed') this.outcome.error = error ?? TURN_FAILED;
    else if (outcome === 'cancelled') this.outcome.cancelled = true;
    else return;
    this.update();
  }

  /**
   * Follow the work at once, so that its start clears the last outcome, and report in
   * the background.
   */
  private update(): void {
    if (!this.agent) return;
    const turning = this.turns > 0 || conversationThreadActivityService.workingThreadIds().length > 0;
    const work = turning ? 'turn' : compactionService.hasInFlight() ? 'compaction' : null;
    if (work && !this.work) this.outcome = noOutcome();
    this.work = work;
    void this.refresh();
  }

  private async refresh(): Promise<void> {
    if (this.refreshing) {
      this.changedAgain = true;
      return;
    }
    this.refreshing = true;
    try {
      do {
        this.changedAgain = false;
        const agent = this.agent!;
        // Read every time, so that a rename shows in the next report.
        const { name } = await prisma.agentWorkspace.findUniqueOrThrow({
          where: { id: agent.id },
          select: { name: true },
        });
        if (this.helpChanged) {
          this.helpChanged = false;
          this.help = (await computerHelpService.waiting(agent.id, agent.userId)).at(-1);
        }
        const sequence = programStatusSequence(this.status(), name);
        if (sequence !== this.written) {
          process.stdout.write(sequence);
          this.written = sequence;
        }
      } while (this.changedAgain);
    } catch (err) {
      logger.warn({ err }, '[ProgramStatus] could not report the agent state');
    } finally {
      this.refreshing = false;
    }
  }

  private status(): ProgramStatus {
    if (this.help) {
      return { state: 'blocked', kind: this.help.credentials ? 'auth' : 'question', msg: this.help.reason };
    }
    if (this.work === 'turn') return { state: 'working', msg: 'Thinking' };
    if (this.work === 'compaction') return { state: 'working', msg: 'Compacting the conversation' };
    if (this.outcome.error) return { state: 'error', msg: this.outcome.error };
    if (this.outcome.cancelled) return { state: 'idle' };
    if (this.outcome.delivered) return { state: 'done', msg: 'Reply ready' };
    return { state: 'idle' };
  }
}

export const programStatusService = new ProgramStatusService();
