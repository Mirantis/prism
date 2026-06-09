/**
 * Tests for teams-config: env-sourced Teams connection singleton.
 *
 * The module validates credentials with a client-credentials token request
 * against Entra ID; `fetch` is stubbed so tests don't hit the network.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// config is read lazily inside teams-config; mock it so we can vary env per test.
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

const mockFetch = vi.fn();

describe('teams-config', () => {
  beforeEach(() => {
    __resetTeamsConfigForTests();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
    (config as MutableConfig).teamsAppId = undefined;
    (config as MutableConfig).teamsAppPassword = undefined;
    (config as MutableConfig).teamsAppTenantId = undefined;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when TEAMS_APP_ID / TEAMS_APP_PASSWORD are not set', async () => {
    const result = await getTeamsConfig();
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when only the app id is set', async () => {
    (config as MutableConfig).teamsAppId = 'app-123';
    const result = await getTeamsConfig();
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('validates credentials and returns the connection record (multi-tenant)', async () => {
    (config as MutableConfig).teamsAppId = 'app-123';
    (config as MutableConfig).teamsAppPassword = 'secret';
    mockFetch.mockResolvedValue({ ok: true });

    const result = await getTeamsConfig();

    expect(result).toMatchObject({
      id: 'app-123',
      appId: 'app-123',
      appPassword: 'secret',
      tenantId: null,
      botId: '28:app-123',
      isActive: true,
    });

    // Multi-tenant validation goes through the botframework.com tenant.
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe('https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('client_id')).toBe('app-123');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('grant_type')).toBe('client_credentials');
  });

  it('uses the tenant-specific token endpoint for single-tenant registrations', async () => {
    (config as MutableConfig).teamsAppId = 'app-123';
    (config as MutableConfig).teamsAppPassword = 'secret';
    (config as MutableConfig).teamsAppTenantId = 'tenant-9';
    mockFetch.mockResolvedValue({ ok: true });

    const result = await getTeamsConfig();

    expect(result?.tenantId).toBe('tenant-9');
    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://login.microsoftonline.com/tenant-9/oauth2/v2.0/token',
    );
  });

  it('throws when credential validation fails', async () => {
    (config as MutableConfig).teamsAppId = 'app-123';
    (config as MutableConfig).teamsAppPassword = 'bad-secret';
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      text: () => Promise.resolve('invalid_client'),
    });

    await expect(getTeamsConfig()).rejects.toThrow(/Teams credential validation failed \(401\)/);
  });

  it('caches the record after the first successful load', async () => {
    (config as MutableConfig).teamsAppId = 'app-123';
    (config as MutableConfig).teamsAppPassword = 'secret';
    mockFetch.mockResolvedValue({ ok: true });

    const first = await getTeamsConfig();
    const second = await getTeamsConfig();

    expect(second).toBe(first);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent loads into a single validation call', async () => {
    (config as MutableConfig).teamsAppId = 'app-123';
    (config as MutableConfig).teamsAppPassword = 'secret';
    mockFetch.mockResolvedValue({ ok: true });

    const [a, b] = await Promise.all([getTeamsConfig(), getTeamsConfig()]);

    expect(a).toBe(b);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
