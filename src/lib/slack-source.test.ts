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

  it('getSlackConnection returns the singleton', async () => {
    mockGetSlackConfig.mockResolvedValue(singletonRecord);
    const result = await getSlackConnection();
    expect(result).toEqual(singletonRecord);
  });

  it('getSlackConnection returns null when Slack is disabled', async () => {
    mockGetSlackConfig.mockResolvedValue(null);
    const result = await getSlackConnection();
    expect(result).toBeNull();
  });
});
