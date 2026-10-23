/**
 * Tests for slack-config: env-sourced Slack connection singleton.
 *
 * The module calls into `@slack/web-api`'s `WebClient`. We mock the constructor
 * so tests don't hit the network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks created via vi.hoisted so vi.mock below can reference them.
const { mockAuthTest, mockBotsInfo } = vi.hoisted(() => ({
  mockAuthTest: vi.fn(),
  mockBotsInfo: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class MockWebClient {
    auth = { test: mockAuthTest };
    bots = { info: mockBotsInfo };
  },
}));

// config is read lazily inside slack-config; mock it so we can vary env per test.
vi.mock('../config', () => ({
  config: {
    slackBotToken: undefined as string | undefined,
    slackExpectedAppId: undefined as string | undefined,
  },
}));

import { config } from '../config';
import { getSlackConfig, __resetSlackConfigForTests } from './slack-config';

describe('slack-config', () => {
  beforeEach(() => {
    __resetSlackConfigForTests();
    mockAuthTest.mockReset();
    mockBotsInfo.mockReset();
    (config as { slackBotToken?: string }).slackBotToken = undefined;
    (config as { slackExpectedAppId?: string }).slackExpectedAppId = undefined;
  });

  it('returns null when SLACK_BOT_TOKEN is not set', async () => {
    const result = await getSlackConfig();
    expect(result).toBeNull();
    expect(mockAuthTest).not.toHaveBeenCalled();
  });

  it('passes through a platform credential sentinel unchanged (MITM swaps on wire)', async () => {
    (config as { slackBotToken?: string }).slackBotToken = '__nexus_cred:abc-123__';
    mockAuthTest.mockResolvedValue({
      team_id: 'T999',
      team: 'Sentinel Team',
      user_id: 'UBOT',
      bot_id: 'B999',
    });

    const result = await getSlackConfig();

    expect(result?.teamId).toBe('T999');
    // auth.test was called with the sentinel token verbatim — the MITM
    // proxy is what swaps it for the real value on the wire.
    expect(mockAuthTest).toHaveBeenCalled();
  });

  it('builds a SlackConnectionRecord from auth.test when app-id check is disabled', async () => {
    (config as { slackBotToken?: string }).slackBotToken = 'xoxb-TEST';
    mockAuthTest.mockResolvedValue({
      team_id: 'T123',
      team: 'Test Team',
      user_id: 'UBOT',
      bot_id: 'B123',
    });

    const result = await getSlackConfig();

    expect(result).toEqual({
      id: 'T123',
      teamId: 'T123',
      teamName: 'Test Team',
      botToken: 'xoxb-TEST',
      botId: 'B123',
      botUserId: 'UBOT',
      installedAt: expect.any(String),
      isActive: true,
    });
    // bots.info is only called when the app-id check is enabled
    expect(mockBotsInfo).not.toHaveBeenCalled();
  });

  it('validates the app_id when SLACK_EXPECTED_APP_ID is set', async () => {
    (config as { slackBotToken?: string }).slackBotToken = 'xoxb-TEST';
    (config as { slackExpectedAppId?: string }).slackExpectedAppId = 'A_EXPECTED';
    mockAuthTest.mockResolvedValue({
      team_id: 'T123',
      team: 'Test Team',
      user_id: 'UBOT',
      bot_id: 'B123',
    });
    mockBotsInfo.mockResolvedValue({ bot: { app_id: 'A_EXPECTED' } });

    const result = await getSlackConfig();

    expect(result?.teamId).toBe('T123');
    expect(mockBotsInfo).toHaveBeenCalledWith({ bot: 'B123' });
  });

  it('throws when the app_id does not match SLACK_EXPECTED_APP_ID', async () => {
    (config as { slackBotToken?: string }).slackBotToken = 'xoxb-TEST';
    (config as { slackExpectedAppId?: string }).slackExpectedAppId = 'A_EXPECTED';
    mockAuthTest.mockResolvedValue({
      team_id: 'T123',
      team: 'Test Team',
      user_id: 'UBOT',
      bot_id: 'B123',
    });
    mockBotsInfo.mockResolvedValue({ bot: { app_id: 'A_OTHER' } });

    await expect(getSlackConfig()).rejects.toThrow(/app ID mismatch/);
  });

  it('caches the result after the first call', async () => {
    (config as { slackBotToken?: string }).slackBotToken = 'xoxb-TEST';
    mockAuthTest.mockResolvedValue({
      team_id: 'T123',
      team: 'Test Team',
      user_id: 'UBOT',
      bot_id: 'B123',
    });

    await getSlackConfig();
    await getSlackConfig();
    await getSlackConfig();

    expect(mockAuthTest).toHaveBeenCalledTimes(1);
  });

  it('throws when auth.test returns no team_id', async () => {
    (config as { slackBotToken?: string }).slackBotToken = 'xoxb-TEST';
    mockAuthTest.mockResolvedValue({ team_id: '', bot_id: 'B123' });

    await expect(getSlackConfig()).rejects.toThrow(/workspace ID/);
  });

  it('throws when auth.test returns no bot_id', async () => {
    (config as { slackBotToken?: string }).slackBotToken = 'xoxb-TEST';
    mockAuthTest.mockResolvedValue({ team_id: 'T123', team: 'Test' });

    await expect(getSlackConfig()).rejects.toThrow(/bot ID/);
  });
});
