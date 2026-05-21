/**
 * Tests for slack-source: thin passthrough over the env-sourced Slack
 * connection singleton.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlackConnectionRecord } from './slack-config';

const { mockGetSlackConfig } = vi.hoisted(() => ({
  mockGetSlackConfig: vi.fn(),
}));

vi.mock('./slack-config', () => ({
  getSlackConfig: mockGetSlackConfig,
}));

import { getActiveSlackConnections, getSlackConnection } from './slack-source';

const singletonRecord: SlackConnectionRecord = {
  id: 'T123',
  teamId: 'T123',
  teamName: 'Test',
  botToken: 'xoxb-TEST',
  botUserId: 'UBOT',
  installedAt: new Date().toISOString(),
  isActive: true,
};

describe('slack-source', () => {
  beforeEach(() => {
    mockGetSlackConfig.mockReset();
  });

  it('returns [singleton] from getActiveSlackConnections when configured', async () => {
    mockGetSlackConfig.mockResolvedValue(singletonRecord);
    const result = await getActiveSlackConnections();
    expect(result).toEqual([singletonRecord]);
  });

  it('returns [] from getActiveSlackConnections when Slack is disabled', async () => {
    mockGetSlackConfig.mockResolvedValue(null);
    const result = await getActiveSlackConnections();
    expect(result).toEqual([]);
  });

  it('getSlackConnection returns the singleton regardless of the id passed', async () => {
    // Legacy mappings may persist a connectionId that predates this runtime;
    // since there is exactly one connection per container, callers always
    // receive the same record.
    mockGetSlackConfig.mockResolvedValue(singletonRecord);
    const result = await getSlackConnection('legacy-connection-id');
    expect(result).toEqual(singletonRecord);
  });

  it('getSlackConnection returns null when Slack is disabled', async () => {
    mockGetSlackConfig.mockResolvedValue(null);
    const result = await getSlackConnection('any-id');
    expect(result).toBeNull();
  });
});
