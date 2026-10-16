import type { ExecutionEnvironment } from '../execution-environments/execution-environment';
import type { LanguageModel } from 'ai';

export type SubscriptionModel = Extract<LanguageModel, { specificationVersion: 'v3' }>;
export type CallOptions = Parameters<SubscriptionModel['doGenerate']>[0];
export type GenerateResult = Awaited<ReturnType<SubscriptionModel['doGenerate']>>;
export type StreamPart = Awaited<ReturnType<SubscriptionModel['doStream']>>['stream'] extends ReadableStream<infer Part> ? Part : never;
export type ToolResult = Extract<Exclude<CallOptions['prompt'][number], { role: 'system' }>['content'][number], { type: 'tool-result' }>;

export type SubscriptionEvent =
  | { type: 'text'; id: string; delta: string }
  | { type: 'tool'; callId: string; name: string; input: unknown }
  | { type: 'complete' };

/** A message Prism added to the conversation after the CLI asked for a tool, such as a steering message. */
export type AddedMessage = Extract<CallOptions['prompt'][number], { role: 'user' }>;

/** How a session ended, for the one telemetry event the provider emits. */
export type SessionOutcome = 'completed' | 'cancelled' | 'failed' | 'login_refused' | 'superseded';

export interface SubscriptionSession {
  events: AsyncIterable<SubscriptionEvent>;
  /** The usage reported since the last step, which ends with this call. */
  takeUsage(): GenerateResult['usage'];
  start(model: string): Promise<void>;
  watchAbort(signal?: AbortSignal): void;
  /** Answers the pending tool calls, with the messages added since, in the same CLI turn. */
  resume(results: ToolResult[], added: AddedMessage[]): void;
  dispose(outcome?: SessionOutcome): void;
}

/** Starts a session. The session calls `finished` once, when it ends. */
export type SessionFactory = (
  target: ExecutionEnvironment,
  options: CallOptions,
  finished: (outcome: SessionOutcome) => void,
) => SubscriptionSession;
