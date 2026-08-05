/**
 * Classification gate — the DELIVER/SUPPRESS LLM call shared by the delivery
 * gates (heartbeat, cron). The caller owns its verdict-rules prompt and
 * user-message construction; this module owns the call shape: fast
 * classification model, tiny output budget, deterministic sampling, and the
 * fail-open default (a transient gate failure must never drop a message).
 */

import { generateText } from 'ai';
import { getClassificationModel } from './classification';
import { langfuseTelemetry } from './telemetry';
import { logger } from '../logger';

/** Window within which an exact repeat of the last delivered text is suppressed. */
const DUPLICATE_SUPPRESSION_HOURS = 24;

export interface ClassificationGateInput {
  /** Full verdict-rules system prompt (the DELIVER/SUPPRESS rules). */
  system: string;
  /** Fully built user message: candidate text plus any last-delivered context. */
  user: string;
  /** Langfuse trace id, e.g. 'heartbeat-gate' or 'cron-gate'. */
  functionId: string;
  /** Added to Langfuse metadata when set. */
  userId?: string;
  /** Log prefix, e.g. 'Heartbeat:Gate' or 'CronScheduler:Gate'. */
  logLabel: string;
}

export async function runClassificationGate(input: ClassificationGateInput): Promise<boolean> {
  try {
    const result = await generateText({
      model: getClassificationModel(),
      system: input.system,
      messages: [{ role: 'user' as const, content: input.user }],
      maxOutputTokens: 10,
      temperature: 0,
      ...langfuseTelemetry(input.functionId, input.userId ? { userId: input.userId } : undefined),
    });
    const shouldDeliver = result.text.trim().toUpperCase().startsWith('DELIVER');
    logger.info(`[${input.logLabel}] Decision: ${result.text.trim()} (deliver=${shouldDeliver})`);
    return shouldDeliver;
  } catch (error) {
    logger.error({ err: error }, `[${input.logLabel}] Gate call failed, defaulting to deliver`);
    return true; // fail-open
  }
}

/** Exact trimmed-match duplicate of the last delivered text within the suppression window. */
export function isRecentDuplicate(
  last: { text: string; at: number } | null | undefined,
  candidate: string,
): boolean {
  if (!last?.text || !last.at) return false;
  const hoursSinceLast = (Date.now() - last.at) / (1000 * 60 * 60);
  if (hoursSinceLast >= DUPLICATE_SUPPRESSION_HOURS) return false;
  return candidate.trim() === last.text.trim();
}
