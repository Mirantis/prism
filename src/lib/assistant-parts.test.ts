/**
 * Stored assistant turn: capture, replay, and the reasoning strip.
 */

import { describe, it, expect } from 'vitest';

import {
  captureAssistantParts,
  parseAssistantParts,
  stripReasoningParts,
  toolCallsIn,
  type StoredAssistantPart,
} from './assistant-parts';

const signature = { anthropic: { signature: 'CAIS8gIKdwgREAEYAipA' } };

describe('captureAssistantParts', () => {
  it('keeps the provider metadata a reasoning block carries', () => {
    // Anthropic requires the signature back unchanged, and it is the difference
    // between the message a turn cached and the one the next turn sends.
    const parts = captureAssistantParts([
      { type: 'reasoning', text: '', providerMetadata: signature },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'list_pods', input: { ns: 'default' } },
    ]);

    expect(parts).toEqual([
      { type: 'reasoning', text: '', providerOptions: signature },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'list_pods', input: { ns: 'default' } },
    ]);
  });

  it('skips what the provider never received', () => {
    // The same three skips the SDK applies when it builds the assistant message:
    // keeping any of them would make replay differ from the live turn.
    const parts = captureAssistantParts([
      { type: 'source', url: 'https://example.test' },
      { type: 'tool-result', toolCallId: 'toolu_1', toolName: 'list_pods', output: 'x' },
      { type: 'text', text: '' },
      { type: 'text', text: 'done' },
    ]);

    expect(parts).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('keeps a tool result the provider ran itself', () => {
    const parts = captureAssistantParts([
      { type: 'tool-result', toolCallId: 'srv_1', toolName: 'web_search', providerExecuted: true },
    ]);

    // Not a part this can carry back, so the row takes the fallback path rather
    // than reaching the provider with the result missing.
    expect(parts).toBeNull();
  });

  it('returns null on a part it cannot carry, rather than a partial turn', () => {
    expect(
      captureAssistantParts([
        { type: 'text', text: 'here you go' },
        { type: 'file', file: { base64: 'AAA', mediaType: 'image/png' } },
      ])
    ).toBeNull();
  });

  it('returns null for a step that produced nothing', () => {
    expect(captureAssistantParts([])).toBeNull();
    expect(captureAssistantParts([{ type: 'text', text: '' }])).toBeNull();
  });
});

describe('parseAssistantParts', () => {
  it('round-trips a captured turn', () => {
    const captured = captureAssistantParts([
      { type: 'reasoning', text: 'thinking', providerMetadata: signature },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'list_pods', input: {} },
    ]);

    expect(parseAssistantParts(JSON.parse(JSON.stringify(captured)))).toEqual(captured);
  });

  it('shortens a stored tool name the tools block no longer sends whole', () => {
    const long = `plugin__server__${'n'.repeat(80)}`;
    const parsed = parseAssistantParts([
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: long, input: {} },
    ]);

    // A name stored while it still fit would otherwise name a tool the request
    // does not offer, which fails the whole request.
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0]).toMatchObject({ type: 'tool-call', toolCallId: 'toolu_1' });
    const name = (parsed![0] as { toolName: string }).toolName;
    expect(name).not.toBe(long);
    expect(name.length).toBeLessThanOrEqual(64);
  });

  it('returns null for a value it cannot replay in full', () => {
    expect(parseAssistantParts(null)).toBeNull();
    expect(parseAssistantParts([])).toBeNull();
    expect(parseAssistantParts('not an array')).toBeNull();
    expect(parseAssistantParts([{ type: 'text', text: 42 }])).toBeNull();
    expect(parseAssistantParts([{ type: 'tool-call', toolName: 'x', input: {} }])).toBeNull();
    expect(parseAssistantParts([{ type: 'image', data: 'AAA' }])).toBeNull();
  });
});

describe('stripReasoningParts', () => {
  it('keeps the text and the calls, and drops the bound reasoning', () => {
    const parts: StoredAssistantPart[] = [
      { type: 'reasoning', text: '', providerOptions: signature },
      { type: 'text', text: 'answer' },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'list_pods', input: {} },
    ];

    expect(stripReasoningParts(parts)).toEqual([
      { type: 'text', text: 'answer' },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'list_pods', input: {} },
    ]);
  });

  it('returns null when reasoning was all there was', () => {
    expect(
      stripReasoningParts([{ type: 'reasoning', text: '', providerOptions: signature }])
    ).toBeNull();
  });
});

describe('toolCallsIn', () => {
  it('returns the calls in the order the provider made them', () => {
    const parts: StoredAssistantPart[] = [
      { type: 'tool-call', toolCallId: 'toolu_2', toolName: 'b', input: {} },
      { type: 'text', text: 'x' },
      { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'a', input: {} },
    ];

    expect(toolCallsIn(parts).map((c) => c.toolCallId)).toEqual(['toolu_2', 'toolu_1']);
  });
});
