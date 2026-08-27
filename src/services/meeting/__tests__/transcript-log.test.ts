/**
 * What a meeting's text is allowed to look like in a log line.
 *
 * One assertion per switch value, because the function is one line and the line is a
 * privacy boundary: inverted, `off` would write the very thing the default exists to
 * keep out of the log, and nothing downstream would notice.
 */

import { describe, it, expect, vi } from 'vitest';

const meetingChatLogging = vi.hoisted(() => ({ value: 'off' as string }));

vi.mock('../../../config', () => ({
  config: {
    get meetingChatLogging() {
      return meetingChatLogging.value;
    },
  },
}));

const { formatChatBody } = await import('../transcript-log');

describe('formatChatBody', () => {
  it('writes nothing at all under off', () => {
    meetingChatLogging.value = 'off';
    expect(formatChatBody('https://example.test/run/42')).toBe('');
  });

  it('writes nothing under redacted either', () => {
    // No stand-in on purpose: the status, the length and the duration are already on
    // the line, and a digest or a prefix of the body is the body.
    meetingChatLogging.value = 'redacted';
    expect(formatChatBody('https://example.test/run/42')).toBe('');
  });

  it('quotes the message under full', () => {
    meetingChatLogging.value = 'full';
    expect(formatChatBody('the build is green')).toBe('text="the build is green"');
  });
});
