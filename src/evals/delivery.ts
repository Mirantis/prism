/**
 * Where an autonomous run's messages land: a heartbeat, scheduled-task or webhook
 * run graded by its outcome, the set of places a message reached. The scenarios
 * state the outcome they expect, so the same scenario measures any delivery
 * design, and `--baseline` compares two of them.
 *
 * The design measured here is the runtime's: a run reaches people only through
 * what the agent posts with `send_message`, within the places its delivery
 * setting allows, which `deliveryTargetService.ceiling` derives.
 */

import { EVAL_USER_ID, runTurn, type TurnTrace } from './harness';
import { heartbeatService } from '../services/heartbeat.service';
import { renderWebhookTurnPrompt } from '../services/webhook.service';
import { scheduledRunPrompt } from '../prompts/scheduled-run-prompt';
import { WEB_CHAT_TARGET, type LinkedTarget } from '../services/channel-adapter.interface';
import { deliveryTargetService, type PostingCeiling } from '../services/delivery-target.service';
import { outboundMessageService } from '../services/outbound-message.service';
import type { TaskLastSend } from '../types';

/** A place a message can reach. A linked channel is named `#name`. */
export type Place = 'web chat' | 'DM' | '#platform-team' | '#releases' | '#general';

/** The linked Slack workspace every run sees: the user's DM, the main channel and two more. */
const LINKED: (LinkedTarget & { place: Place })[] = [
  { key: 'slack:D0ANA0001', place: 'DM', platform: 'slack', kind: 'dm', conversationId: 'D0ANA0001', name: 'Ana Example', isMain: false, dmUserId: EVAL_USER_ID },
  { key: 'slack:C0TEAM001', place: '#platform-team', platform: 'slack', kind: 'channel', conversationId: 'C0TEAM001', name: 'platform-team', isMain: true },
  { key: 'slack:C0REL0001', place: '#releases', platform: 'slack', kind: 'channel', conversationId: 'C0REL0001', name: 'releases', isMain: false },
  { key: 'slack:C0GEN0001', place: '#general', platform: 'slack', kind: 'channel', conversationId: 'C0GEN0001', name: 'general', isMain: false },
];

/** A run's delivery setting, as the user chose it for the task, webhook or heartbeat. */
export type Ceiling =
  | { deliverTo: 'all' | 'chat' | 'none' }
  | { deliverTo: 'slack'; channels?: Place[] };

/** A message an earlier run sent, which the next run is told about. */
export interface EarlierMessage {
  text: string;
  hoursAgo: number;
}

export interface AutonomousRun {
  mode: 'heartbeat' | 'cron' | 'webhook';
  /** The task instruction, the webhook's subscription prompt, or the heartbeat's checks. */
  instruction: string;
  /** The webhook event. */
  payload?: Record<string, unknown>;
  ceiling?: Ceiling;
  earlier?: EarlierMessage;
  /** What `shell_exec` prints, per command. */
  shell?: (command: string) => string;
  /** Results for other named tools. */
  stubs?: Record<string, (input: Record<string, unknown>) => unknown>;
  maxSteps?: number;
}

/** A posted message, with the id the post returned and the thread it went into. */
export interface Posted {
  place: Place;
  text: string;
  messageId: string;
  thread?: string;
}

export interface Outcome {
  /** Every message that reached a place. */
  reached: Posted[];
  trace: TurnTrace;
  detail: string;
}

/** The places a delivery setting allows: `deliveryTargetService.ceiling` itself, over the linked workspace. */
async function postingCeiling(ceiling: Ceiling): Promise<PostingCeiling> {
  const channelIds =
    ceiling.deliverTo === 'slack'
      ? LINKED.filter((t) => ceiling.channels?.includes(t.place)).map((t) => t.conversationId)
      : [];
  const listTargets = outboundMessageService.listTargets;
  outboundMessageService.listTargets = async () => LINKED;
  try {
    return await deliveryTargetService.ceiling('eval-agent', { deliverTo: ceiling.deliverTo, channelIds });
  } finally {
    outboundMessageService.listTargets = listTargets;
  }
}

/** `send_message` and `list_message_targets` as `outboundMessageService` answers them under a ceiling. */
function sendStubs(ceiling: PostingCeiling, sent: Posted[]) {
  const allowed = [...(ceiling.webChat ? [WEB_CHAT_TARGET] : []), ...ceiling.targets.map((t) => t.key)];
  const resolve = (target: string): { key: string; place: Place } | undefined => {
    if (target === WEB_CHAT_TARGET) return { key: WEB_CHAT_TARGET, place: 'web chat' };
    return LINKED.find((t) => t.key === target || `#${t.name}` === target || t.name === target);
  };
  return {
    list_message_targets: () => ({
      targets: [
        ...(ceiling.webChat ? [{ target: WEB_CHAT_TARGET, platform: WEB_CHAT_TARGET, kind: WEB_CHAT_TARGET, name: 'Web chat', main: false }] : []),
        ...ceiling.targets.map((t) => ({ target: t.key, platform: t.platform, kind: t.kind, name: t.name, main: t.isMain })),
      ],
    }),
    send_message: (input: Record<string, unknown>) => {
      const target = resolve(String(input.target ?? ''));
      if (!target || !allowed.includes(target.key)) {
        throw new Error(
          `Your delivery setting does not let this run post to "${String(input.target)}", so nothing was sent. This run may post to: ${allowed.join(', ')}.`,
        );
      }
      const messageId = `1761638400.${String(sent.length + 1).padStart(6, '0')}`;
      const thread = typeof input.thread === 'string' ? input.thread : undefined;
      sent.push({ place: target.place, text: String(input.text ?? ''), messageId, thread });
      return { sent: true, target: target.key, name: target.place, messageId };
    },
  };
}

function runPrompt(run: AutonomousRun): string {
  if (run.mode === 'heartbeat') return heartbeatService['buildHeartbeatPrompt']();
  if (run.mode === 'webhook') return renderWebhookTurnPrompt(run.instruction, run.payload ?? {}, 'unknown', 'deploy-events');
  return scheduledRunPrompt(run.instruction);
}

/** What the run is told an earlier run sent, as the scheduler and the heartbeat record it. */
function lastSendOf(earlier: EarlierMessage | undefined): TaskLastSend | undefined {
  if (!earlier) return undefined;
  const at = Date.now() - earlier.hoursAgo * 3_600_000;
  return { messages: `- To slack:D0ANA0001: ${earlier.text}`, at };
}

/** Run one heartbeat, scheduled-task or webhook run and report every place a message reached. */
export async function runAutonomous(run: AutonomousRun): Promise<Outcome> {
  const ceiling = await postingCeiling(run.ceiling ?? { deliverTo: 'all' });
  const reached: Posted[] = [];

  const trace = await runTurn({
    mode: run.mode,
    prompt: runPrompt(run),
    maxSteps: run.maxSteps ?? 6,
    postingCeiling: ceiling,
    lastSend: run.mode === 'webhook' ? undefined : lastSendOf(run.earlier),
    context: run.mode === 'heartbeat' && run.instruction ? { heartbeatMd: run.instruction } : {},
    stubs: {
      ...sendStubs(ceiling, reached),
      ...run.stubs,
      shell_exec: (input) => ({ stdout: run.shell?.(String(input.command ?? '')) ?? '', stderr: '', exitCode: 0 }),
    },
  });

  const places = reached.map((r) => `${r.place}: ${clip(r.text, 100)}`).join(' / ') || 'nothing';
  const calls = trace.calls.map((c) => `${c.step}:${c.tool}`).join(' ');
  return { reached, trace, detail: `reached ${places} | ${calls} | text: ${clip(trace.text, 200)}` };
}

/** The places a message reached, each once. */
export function placesOf(outcome: Outcome): Set<Place> {
  return new Set(outcome.reached.map((r) => r.place));
}

/** The user saw it: in web chat or a DM. */
export function reachedUser(outcome: Outcome): boolean {
  const places = placesOf(outcome);
  return places.has('web chat') || places.has('DM');
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
