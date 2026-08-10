import { describe, it, expect } from 'vitest';
import { GoogleMeetProvider } from '../providers/google-meet.provider';

const provider = new GoogleMeetProvider();

describe('GoogleMeetProvider.matchesUrl', () => {
  it('accepts a Meet link', () => {
    expect(provider.matchesUrl('https://meet.google.com/abc-defg-hij')).toBe(true);
  });

  it('accepts a Meet link with query parameters', () => {
    expect(provider.matchesUrl('https://meet.google.com/abc-defg-hij?authuser=0')).toBe(true);
  });

  it('rejects other platforms', () => {
    expect(provider.matchesUrl('https://teams.microsoft.com/l/meetup-join/x')).toBe(false);
    expect(provider.matchesUrl('https://zoom.us/j/123456')).toBe(false);
  });

  it('rejects a lookalike host', () => {
    // Would be a real hazard: an attacker-controlled host that ends in the same
    // string. Hostname is compared exactly, not by suffix.
    expect(provider.matchesUrl('https://meet.google.com.evil.test/abc')).toBe(false);
    expect(provider.matchesUrl('https://notmeet.google.com/abc')).toBe(false);
  });

  it('rejects plain http', () => {
    expect(provider.matchesUrl('http://meet.google.com/abc-defg-hij')).toBe(false);
  });

  it('rejects junk without throwing', () => {
    expect(provider.matchesUrl('not a url')).toBe(false);
    expect(provider.matchesUrl('')).toBe(false);
  });
});

describe('GoogleMeetProvider identity', () => {
  it('names itself for tools, logs and telemetry', () => {
    expect(provider.name).toBe('google-meet');
    expect(provider.displayName).toBe('Google Meet');
  });
});
