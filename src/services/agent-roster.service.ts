/**
 * Agent Roster Service
 *
 * Keeps a conversation's model told which other agents of the project exist and
 * what each one does, so it can hand them work without asking for the list.
 * Before a chat turn, at most once a minute per conversation, it calls the Lens
 * Agents `list_agents` tool with the roster version the conversation last read,
 * and stores what is new as a hidden message (`internalStep`): the whole roster
 * the first time and once a compaction folded it away, otherwise the
 * difference. The message replays with the history, so the cached prefix stays
 * the same from turn to turn.
 *
 * Chat turns are the runs that read the roster: a heartbeat, a scheduled task, a
 * goal or a webhook run calls `list_agents` itself when it needs to. On an
 * endpoint without that tool the check ends at the tool listing.
 */

import { z } from 'zod';
import { config } from '../config';
import prisma from '../lib/prisma';
import { logger } from '../logger';
import { callListAgents } from '../lib/mcp-client';
import { fullRosterNotice, rosterUpdateNotice, type Roster } from '../prompts/agent-roster-prompt';
import { conversationService } from './conversation.service';
import { runtimeStateService } from './runtime-state.service';

const CHECK_INTERVAL_MS = 60_000;
/** The turn waits for the check, so a slow endpoint costs it this much at most. */
const CHECK_TIMEOUT_MS = 10_000;

/** What a conversation last read, under `agentRoster:<threadId>` in `runtime_state`. */
interface RosterSnapshot extends Roster {
  version: string;
  /** The hidden message that holds the whole roster the conversation read. */
  noticeMessageId: string;
  /** When the roster was last read, as ISO 8601. */
  checkedAt: string;
}

const rosterAgent = z.object({ id: z.string(), name: z.string(), role: z.string().nullable() });

/** The first line of the tool's answer. The rest is the same roster for a model to read. */
const listAgentsAnswer = z.union([
  z.object({ version: z.string(), unchanged: z.literal(true) }),
  z.object({ version: z.string(), self: rosterAgent, agents: z.array(rosterAgent) }),
]);

const snapshotKey = (threadId: string) => `agentRoster:${threadId}`;

class AgentRosterService {
  /** When each conversation's roster was last asked for. */
  private readonly attempts = new Map<string, number>();

  /** Bring the conversation's roster up to date before a chat turn. Never throws. */
  async beforeChatTurn(threadId: string, turnSignal: AbortSignal): Promise<void> {
    if (!config.nexusMcpUrl) return;
    const now = Date.now();
    if (now - (this.attempts.get(threadId) ?? Number.NEGATIVE_INFINITY) < CHECK_INTERVAL_MS) return;
    this.attempts.set(threadId, now);
    try {
      await this.check(threadId, AbortSignal.any([turnSignal, AbortSignal.timeout(CHECK_TIMEOUT_MS)]));
    } catch (err) {
      logger.warn({ err, threadId }, '[AgentRoster] Could not read the roster of the other agents');
    }
  }

  private async check(threadId: string, signal: AbortSignal): Promise<void> {
    const snapshot = await this.readableSnapshot(threadId);
    // An empty version matches none, so the answer holds the whole roster.
    const text = await callListAgents({ knownVersion: snapshot?.version ?? '' }, signal);
    if (text === null) return;
    const answer = listAgentsAnswer.parse(JSON.parse(text.split('\n', 1)[0]));
    const checkedAt = new Date().toISOString();

    if ('unchanged' in answer) {
      if (!snapshot) throw new Error('list_agents answered unchanged for an unknown version');
      await this.save(threadId, { ...snapshot, checkedAt });
      return;
    }
    const roster: Roster = { self: answer.self, agents: answer.agents };
    if (!snapshot) {
      const noticeMessageId = await this.addNotice(threadId, fullRosterNotice(roster));
      await this.save(threadId, { ...roster, version: answer.version, noticeMessageId, checkedAt });
      return;
    }
    const update = rosterUpdateNotice(snapshot, roster);
    if (update) await this.addNotice(threadId, update);
    await this.save(threadId, { ...snapshot, ...roster, version: answer.version, checkedAt });
  }

  /** The conversation's snapshot while its model still reads the whole roster it names. */
  private async readableSnapshot(threadId: string): Promise<RosterSnapshot | null> {
    const stored = await runtimeStateService.get(snapshotKey(threadId));
    if (!stored) return null;
    const snapshot = JSON.parse(stored) as RosterSnapshot;
    // Compaction flags every row it folds into the summary, a hidden one included.
    const notice = await prisma.conversationMessage.findUnique({
      where: { id: snapshot.noticeMessageId },
      select: { isCompacted: true },
    });
    return notice && !notice.isCompacted ? snapshot : null;
  }

  private async addNotice(threadId: string, content: string): Promise<string> {
    const { message } = await conversationService.addMessage(threadId, {
      content,
      role: 'USER',
      triggeredBy: 'USER_INPUT',
      internalStep: true,
    });
    return message.id;
  }

  private async save(threadId: string, snapshot: RosterSnapshot): Promise<void> {
    await runtimeStateService.set(snapshotKey(threadId), JSON.stringify(snapshot));
  }

  /** Forget when each conversation was checked, as a restart would. For tests. */
  resetForTests(): void {
    this.attempts.clear();
  }
}

export const agentRosterService = new AgentRosterService();
