/**
 * Langfuse tracing-pipeline tests.
 *
 * These run the real `ai` SDK and the real `@ai-sdk/otel` integration against
 * an in-memory span exporter — no `vi.mock` of either. They assert on the two
 * span facts `LangfuseSpanProcessor` depends on, and on the one case that must
 * produce no span at all.
 *
 * Why a test at this level: the SDK does not write spans itself. It calls
 * whatever telemetry integration is registered, so an unregistered — or
 * renamed, or reshaped — integration means every trace silently disappears.
 * Nothing fails, nothing warns, and `tsc` sees no problem; the only symptom is
 * an empty Langfuse. A mocked SDK cannot see that, because the thing under
 * test is the SDK's own emission.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { generateText, registerTelemetry } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { LegacyOpenTelemetry } from '@ai-sdk/otel';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

const exporter = new InMemorySpanExporter();

/** A model that answers immediately; the response body is not what's under test. */
const model = new MockLanguageModelV4({
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    // Provider-level `finishReason` is an object, and provider-level usage is
    // nested per token class — both unlike the flat string and flat
    // `usage.inputTokens` the top-level SDK result exposes.
    finishReason: { unified: 'stop' as const, raw: 'end_turn' },
    usage: {
      inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 1, text: 1, reasoning: 0 },
    },
    warnings: [],
  }),
});

/** Span names the SDK writes for a `generateText` call, under scope `ai`. */
const aiSpans = () => exporter.getFinishedSpans().filter((s) => s.name.startsWith('ai.'));

let provider: BasicTracerProvider;

beforeAll(() => {
  provider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // The integration takes its tracer up front, so it is handed one explicitly
  // here rather than through the global provider that `initLangfuse()` starts.
  registerTelemetry(new LegacyOpenTelemetry({ tracer: provider.getTracer('test') }));
});

beforeEach(() => {
  exporter.reset();
});

// `registerTelemetry` is process-global, which vitest's per-file isolation
// already contains. Torn down anyway so the file stays correct under
// `isolate: false`.
afterAll(async () => {
  await provider.shutdown();
  exporter.reset();
});

describe('Langfuse tracing pipeline', () => {
  it('emits the span name and prompt attribute Langfuse reads', async () => {
    await generateText({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      experimental_telemetry: { isEnabled: true, functionId: 'probe' },
    });

    const names = aiSpans().map((s) => s.name);
    expect(names).toContain('ai.generateText');
    expect(names).toContain('ai.generateText.doGenerate');

    // `LangfuseSpanProcessor` reads the conversation out of these two
    // attributes, one on each span. A span that arrives without them renders in
    // Langfuse with no prompt, which is nearly as useless as no span at all.
    const outer = aiSpans().find((s) => s.name === 'ai.generateText');
    expect(outer?.attributes['ai.prompt']).toBeDefined();
    expect(outer?.attributes['operation.name']).toBe('ai.generateText probe');

    const inner = aiSpans().find((s) => s.name === 'ai.generateText.doGenerate');
    expect(inner?.attributes['ai.prompt.messages']).toBeDefined();
  });

  it('carries a call site’s identifiers onto the span', async () => {
    // What `langfuseTelemetry(fn, identifiers)` builds. The predecessor of this
    // shape passed the identifiers as a telemetry `metadata` field, which v7
    // does not have; they were dropped, every trace kept arriving, and nothing
    // failed. Assert on the values themselves so the next such removal cannot
    // pass unnoticed.
    await generateText({
      model,
      messages: [{ role: 'user', content: 'hello' }],
      runtimeContext: { userId: 'user-1', sessionId: 'thread-1' },
      experimental_telemetry: {
        isEnabled: true,
        functionId: 'probe',
        includeRuntimeContext: { userId: true, sessionId: true },
      },
    });

    const outer = aiSpans().find((s) => s.name === 'ai.generateText');
    expect(outer?.attributes['ai.settings.context.userId']).toBe('user-1');
    expect(outer?.attributes['ai.settings.context.sessionId']).toBe('thread-1');
  });

  it('emits nothing when a call site opts out', async () => {
    await generateText({
      model,
      messages: [{ role: 'user', content: 'a slack transcript' }],
      experimental_telemetry: { isEnabled: false },
    });

    // The Slack thread classifier relies on this: its prompt is a channel
    // transcript, and an integration being registered must not start recording
    // it. Under this SDK an *absent* telemetry option means enabled, so the
    // opt-out has to be written down — and has to work.
    expect(aiSpans()).toHaveLength(0);
  });

  it('traces without recording content when asked', async () => {
    await generateText({
      model,
      messages: [{ role: 'user', content: 'somebody else’s speech' }],
      experimental_telemetry: { isEnabled: true, functionId: 'probe', recordInputs: false },
    });

    // What `langfuseTelemetry(..., { recordContent: false })` buys the meeting
    // gate: the call is still timed and counted, the words never leave the host.
    const outer = aiSpans().find((s) => s.name === 'ai.generateText');
    expect(outer).toBeDefined();
    expect(outer?.attributes['ai.prompt']).toBeUndefined();

    const inner = aiSpans().find((s) => s.name === 'ai.generateText.doGenerate');
    expect(inner).toBeDefined();
    expect(inner?.attributes['ai.prompt.messages']).toBeUndefined();
  });
});
