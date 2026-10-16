import { config } from '../../config';
import type { ExecutionEnvironment } from '../execution-environments/execution-environment';
import { trackEvent } from '../telemetry';
import { NO_CACHE_POINT, type LlmProvider } from './llm-provider';
import type {
  AddedMessage, CallOptions, GenerateResult, SessionFactory, StreamPart, SubscriptionModel, SubscriptionSession, ToolResult,
} from './subscription-types';

/** Tells the model about a file it cannot read, so it can ask for the text instead of guessing. */
export function unreadableFile(part: { mediaType: string; filename?: string }): string {
  return `[Attached ${part.filename ?? 'file'} (${part.mediaType}): this model cannot read it. Ask for its text if you need it.]`;
}

/** The user messages after the model's last message: what Prism added while the CLI waited for a tool. */
function addedMessages(prompt: CallOptions['prompt']): AddedMessage[] {
  let last = prompt.length - 1;
  while (last >= 0 && prompt[last].role !== 'assistant') last--;
  return prompt.slice(last + 1).filter((message): message is AddedMessage => message.role === 'user');
}

export function createSubscriptionProvider(provider: string, createSession: SessionFactory, environment?: ExecutionEnvironment): LlmProvider {
  const dispatcher = (modelId: string): SubscriptionModel => {
    const sessions = new Map<string, SubscriptionSession>();
    const start = (target: ExecutionEnvironment, options: CallOptions) => {
      const startedAt = Date.now();
      return createSession(target, options, (outcome) => trackEvent('subscription session finished', config.ownerUserId, {
        provider, outcome, elapsed_ms: String(Date.now() - startedAt),
      }));
    };
    async function* step(options: CallOptions): AsyncGenerator<StreamPart> {
      options.abortSignal?.throwIfAborted();
      const results = options.prompt.flatMap((message) => message.role === 'tool'
        ? message.content.filter((part): part is ToolResult => part.type === 'tool-result') : []);
      let session = results.map((result) => sessions.get(result.toolCallId)).find(Boolean);
      const continuing = Boolean(session);
      if (!session) {
        // A new conversation step means no open session will get its tool results any more.
        for (const open of new Set(sessions.values())) open.dispose('superseded');
        sessions.clear();
        const target = environment ?? (await import('../execution-environments/get-execution-environment')).getExecutionEnvironment();
        session = start(target, options);
      }
      session.watchAbort(options.abortSignal);
      let textId: string | undefined;
      try {
        if (continuing) {
          session.resume(results, addedMessages(options.prompt));
          for (const result of results) sessions.delete(result.toolCallId);
        } else await session.start(modelId);
        yield { type: 'stream-start', warnings: [] };
        for await (const event of session.events) {
          if (event.type === 'text') {
            if (textId !== event.id) {
              if (textId) yield { type: 'text-end', id: textId };
              textId = event.id;
              yield { type: 'text-start', id: textId };
            }
            yield { type: 'text-delta', id: textId, delta: event.delta };
            continue;
          }
          if (textId) yield { type: 'text-end', id: textId };
          if (event.type === 'tool') {
            sessions.set(event.callId, session);
            yield { type: 'tool-call', toolCallId: event.callId, toolName: event.name, input: JSON.stringify(event.input) };
            yield { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage: session.takeUsage() };
            return;
          }
          session.dispose();
          yield { type: 'finish', finishReason: { unified: 'stop', raw: 'completed' }, usage: session.takeUsage() };
          return;
        }
      } catch (error) {
        session.dispose('failed');
        for (const [id, active] of sessions) if (active === session) sessions.delete(id);
        throw error;
      }
    }
    return {
      specificationVersion: 'v3', provider, modelId, supportedUrls: {},
      async doGenerate(options) {
        const content: GenerateResult['content'] = [];
        let result: GenerateResult | undefined;
        for await (const part of step(options)) {
          if (part.type === 'text-delta') {
            const previous = content[content.length - 1];
            if (previous?.type === 'text') previous.text += part.delta;
            else content.push({ type: 'text', text: part.delta });
          } else if (part.type === 'tool-call') content.push(part);
          else if (part.type === 'finish') result = { content, finishReason: part.finishReason, usage: part.usage, warnings: [] };
        }
        if (!result) throw new Error(`${provider} returned no terminal model result.`);
        return result;
      },
      async doStream(options) {
        const cancellation = new AbortController();
        const abortSignal = options.abortSignal
          ? AbortSignal.any([options.abortSignal, cancellation.signal]) : cancellation.signal;
        const iterator = step({ ...options, abortSignal });
        return { stream: new ReadableStream<StreamPart>({
          async pull(controller) {
            try {
              const next = await iterator.next();
              if (next.done) controller.close();
              else controller.enqueue(next.value);
            } catch (error) { controller.error(error); }
          },
          async cancel() { cancellation.abort(); await iterator.return(undefined); },
        }) };
      },
    };
  };
  return Object.assign(dispatcher, {
    cachePoint: () => NO_CACHE_POINT,
    classificationSamplingParams: {},
  });
}
