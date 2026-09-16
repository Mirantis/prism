/**
 * Message Boundaries Tests
 *
 * Two texts that reach the model inside one provider block are separated by a
 * blank line, and the text after the seam is never touched — which is what keeps
 * a recall row's stored bytes and a sent block's bytes the same string.
 */

import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { withTextBoundaries } from './message-boundaries';

const RECALL = 'Context:\n<recalled-memories>\n- Mario likes chocolate\n</recalled-memories>';
const STUB = '[Attachment: spec.pdf · id=att-9 · application/pdf · 12 KB] — use view_attachment to read it.';

describe('withTextBoundaries', () => {
  it('separates a user turn from the recall block that follows it', () => {
    const result = withTextBoundaries([
      { role: 'user', content: 'which models are available through Bedrock' },
      { role: 'user', content: RECALL },
    ]);

    expect(result).toEqual([
      { role: 'user', content: 'which models are available through Bedrock\n\n' },
      // The injected block keeps its own bytes: it is stored as this string too.
      { role: 'user', content: RECALL },
    ]);
  });

  it('separates a user text from the attachment stubs in the same message', () => {
    const result = withTextBoundaries([
      { role: 'user', content: [
        { type: 'text', text: 'have a look at these' },
        { type: 'text', text: STUB },
        { type: 'text', text: STUB.replace('spec.pdf', 'notes.pdf') },
      ] },
    ]);

    expect(result[0].content).toEqual([
      { type: 'text', text: 'have a look at these\n\n' },
      { type: 'text', text: `${STUB}\n\n` },
      // The last stub has nothing behind it, so it ends as it was written.
      { type: 'text', text: STUB.replace('spec.pdf', 'notes.pdf') },
    ]);
  });

  it('separates two injected blocks folded into one turn', () => {
    const result = withTextBoundaries([
      { role: 'user', content: 'review the PR' },
      { role: 'user', content: 'actually, skip the tests' },
      { role: 'user', content: 'and rebase it' },
    ]);

    expect(result.map((m) => m.content)).toEqual([
      'review the PR\n\n',
      'actually, skip the tests\n\n',
      'and rebase it',
    ]);
  });

  it('separates the last part of a message from the text of the next one', () => {
    const result = withTextBoundaries([
      { role: 'user', content: [
        { type: 'text', text: 'the file' },
        { type: 'text', text: STUB },
      ] },
      { role: 'user', content: RECALL },
    ]);

    expect(result[0].content).toEqual([
      { type: 'text', text: 'the file\n\n' },
      { type: 'text', text: `${STUB}\n\n` },
    ]);
  });

  it('adds nothing on a second pass', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a question' },
      { role: 'user', content: [{ type: 'text', text: 'a note' }, { type: 'text', text: STUB }] },
      { role: 'user', content: RECALL },
    ];

    const once = withTextBoundaries(messages);
    expect(withTextBoundaries(once)).toEqual(once);
  });

  it('completes a text that already ends on a single newline', () => {
    const result = withTextBoundaries([
      { role: 'user', content: 'a list:\n- one\n' },
      { role: 'user', content: RECALL },
    ]);

    expect(result[0].content).toBe('a list:\n- one\n\n');
  });

  it('leaves a turn the model answers alone', () => {
    const messages: ModelMessage[] = [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'a question' },
      { role: 'assistant', content: 'an answer' },
      { role: 'user', content: 'another question' },
    ];

    expect(withTextBoundaries(messages)).toEqual(messages);
  });

  it('leaves a text in front of a tool result alone', () => {
    // The adapter groups the run into one message, but a tool result is its own
    // block type — there is no text next to the text.
    const messages: ModelMessage[] = [
      { role: 'user', content: 'read the doc' },
      { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 't1', toolName: 'read', input: {} }] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'text', value: 'ok' } },
      ] },
      { role: 'user', content: 'thanks' },
    ];

    expect(withTextBoundaries(messages)).toEqual(messages);
  });

  it('leaves a text in front of a file part alone', () => {
    // A viewed document arrives as a user message opening on the file itself.
    const messages: ModelMessage[] = [
      { role: 'user', content: 'read this' },
      { role: 'user', content: [
        { type: 'file', mediaType: 'application/pdf', data: 'JVBERi0=', filename: 'spec.pdf' },
        { type: 'text', text: 'spec.pdf, as requested.' },
      ] },
    ];

    expect(withTextBoundaries(messages)).toEqual(messages);
  });

  it('keeps a message its provider options', () => {
    const cachePoint = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    const result = withTextBoundaries([
      { role: 'user', content: 'a question', providerOptions: cachePoint },
      { role: 'user', content: RECALL },
    ]);

    expect(result[0]).toEqual({ role: 'user', content: 'a question\n\n', providerOptions: cachePoint });
  });

  it('leaves the array it was given as it was', () => {
    // The caller keeps the same array for the compaction fork and the
    // early-stopping call, so the pass has to build a new one.
    const parts = [{ type: 'text' as const, text: 'a note' }, { type: 'text' as const, text: STUB }];
    const messages: ModelMessage[] = [
      { role: 'user', content: 'a question' },
      { role: 'user', content: parts },
    ];

    withTextBoundaries(messages);

    expect(messages[0].content).toBe('a question');
    expect(parts[0].text).toBe('a note');
  });
});
