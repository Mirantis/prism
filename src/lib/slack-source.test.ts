/**
 * Tests for slack-source: routes Slack connection lookups between the
 * env-sourced singleton (single-agent mode) and `backendClient` (legacy).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SlackConnectionRecord } from './backend-client';

const { mockBackendClient, mockGetSlackConfig } = vi.hoisted(() => ({
  mockBackendClient: {
    getActiveSlackConnections: vi.fn(),
    getSlackConnection: vi.fn(),
  },
  mockGetSlackConfig: vi.fn(),
}));

vi.mock('./backend-client', () => ({
  backendClient: mockBackendClient,
}));

vi.mock('./slack-config', () => ({
  getSlackConfig: mockGetSlackConfig,
}));

vi.mock('../config', () => ({
  config: {
    singleAgentMode: false,
  },
}));

import { config } from '../config';
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
    mockBackendClient.getActiveSlackConnections.mockReset();
    mockBackendClient.getSlackConnection.mockReset();
    mockGetSlackConfig.mockReset();
    (config as { singleAgentMode: boolean }).singleAgentMode = false;
  });

  describe('multi-tenant (backend) mode', () => {
    it('delegates getActiveSlackConnections to backendClient', async () => {
      mockBackendClient.getActiveSlackConnections.mockResolvedValue([singletonRecord]);
      const result = await getActiveSlackConnections();
      expect(mockBackendClient.getActiveSlackConnections).toHaveBeenCalled();
      expect(mockGetSlackConfig).not.toHaveBeenCalled();
      expect(result).toEqual([singletonRecord]);
    });

    it('delegates getSlackConnection to backendClient', async () => {
      mockBackendClient.getSlackConnection.mockResolvedValue(singletonRecord);
      const result = await getSlackConnection('some-id');
      expect(mockBackendClient.getSlackConnection).toHaveBeenCalledWith('some-id');
      expect(mockGetSlackConfig).not.toHaveBeenCalled();
      expect(result).toEqual(singletonRecord);
    });
  });

  describe('single-agent mode', () => {
    beforeEach(() => {
      (config as { singleAgentMode: boolean }).singleAgentMode = true;
    });

    it('returns [singleton] from getActiveSlackConnections when configured', async () => {
      mockGetSlackConfig.mockResolvedValue(singletonRecord);
      const result = await getActiveSlackConnections();
      expect(result).toEqual([singletonRecord]);
      expect(mockBackendClient.getActiveSlackConnections).not.toHaveBeenCalled();
    });

    it('returns [] from getActiveSlackConnections when Slack is disabled', async () => {
      mockGetSlackConfig.mockResolvedValue(null);
      const result = await getActiveSlackConnections();
      expect(result).toEqual([]);
    });

    it('getSlackConnection returns the singleton regardless of the id passed', async () => {
      // Legacy mappings may persist a connectionId that predates this mode;
      // since there is exactly one connection in single-agent mode, callers
      // always receive the same record.
      mockGetSlackConfig.mockResolvedValue(singletonRecord);
      const result = await getSlackConnection('legacy-connection-id');
      expect(result).toEqual(singletonRecord);
      expect(mockBackendClient.getSlackConnection).not.toHaveBeenCalled();
    });

    it('getSlackConnection returns null when Slack is disabled', async () => {
      mockGetSlackConfig.mockResolvedValue(null);
      const result = await getSlackConnection('any-id');
      expect(result).toBeNull();
    });
  });
});
