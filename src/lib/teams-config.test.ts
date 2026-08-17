/**
 * Tests for teams-config: env-sourced Teams connection singleton.
 *
 * Unlike slack-config there is no network validation here — credential
 * validation happens inside the Teams SDK's App.initialize().
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../config', () => ({
  config: {
    teamsAppId: undefined as string | undefined,
    teamsAppPassword: undefined as string | undefined,
    teamsAppTenantId: undefined as string | undefined,
  },
}));

import { config } from '../config';
import { getTeamsConfig, __resetTeamsConfigForTests } from './teams-config';

type MutableConfig = {
  teamsAppId?: string;
  teamsAppPassword?: string;
  teamsAppTenantId?: string;
};

describe('teams-config', () => {
  beforeEach(() => {
    __resetTeamsConfigForTests();
    const c = config as MutableConfig;
    c.teamsAppId = undefined;
    c.teamsAppPassword = undefined;
    c.teamsAppTenantId = undefined;
  });

  it('returns null when no Teams env is set', async () => {
    expect(await getTeamsConfig()).toBeNull();
  });

  it.each([
    ['app id only', { teamsAppId: 'app-1' }],
    ['password only', { teamsAppPassword: 'secret' }],
    ['tenant only', { teamsAppTenantId: 'tenant-1' }],
    ['app id + password, no tenant', { teamsAppId: 'app-1', teamsAppPassword: 'secret' }],
  ])('returns null on a partial config: %s', async (_label, partial) => {
    Object.assign(config as MutableConfig, partial);
    expect(await getTeamsConfig()).toBeNull();
  });

  it('builds a TeamsConnectionRecord when all three vars are set', async () => {
    const c = config as MutableConfig;
    c.teamsAppId = 'app-1';
    c.teamsAppPassword = 'secret';
    c.teamsAppTenantId = 'tenant-1';

    expect(await getTeamsConfig()).toEqual({
      id: 'tenant-1',
      tenantId: 'tenant-1',
      clientId: 'app-1',
      name: 'Microsoft Teams',
    });
  });

  it('caches the result (including null) until reset', async () => {
    expect(await getTeamsConfig()).toBeNull();

    // Setting env after the first load does not change the cached answer…
    const c = config as MutableConfig;
    c.teamsAppId = 'app-1';
    c.teamsAppPassword = 'secret';
    c.teamsAppTenantId = 'tenant-1';
    expect(await getTeamsConfig()).toBeNull();

    // …until the cache is reset.
    __resetTeamsConfigForTests();
    expect((await getTeamsConfig())?.tenantId).toBe('tenant-1');
  });
});
