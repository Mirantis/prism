import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { store, mockTrackEvent } = vi.hoisted(() => ({
  store: new Map<string, string>(),
  mockTrackEvent: vi.fn(),
}));

vi.mock('./runtime-state.service', () => ({
  CHATGPT_AUTH_HOST_ID: 'chatgptAuthHostId',
  CHATGPT_AUTH_CLIENT_ID: 'chatgptAuthClientId',
  CHATGPT_AUTH_TOKENS: 'chatgptAuthTokens',
  runtimeStateService: {
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
  },
}));

vi.mock('../lib/telemetry', () => ({
  trackEvent: mockTrackEvent,
}));

vi.mock('../logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  CHATGPT_AGENT_NAME_HINT,
  CHATGPT_API_RESOURCE,
  CHATGPT_AUTHORIZE_URL,
  CHATGPT_DIRECT_USAGE_SCOPE,
  CHATGPT_DYNAMIC_CLIENT_ID,
  CHATGPT_OAUTH_SCOPES,
  CHATGPT_TOKEN_URL,
  ChatGptAuthError,
  chatGptAuthService,
} from './chatgpt-auth.service';

function makeIdToken(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('chatGptAuthService', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    store.clear();
    chatGptAuthService._resetForTests();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('starts first-time sign-in with dynamic_agent_client, agent_name_hint, and persistent ext_agent_host_id', async () => {
    const first = await chatGptAuthService.startSignIn('http://127.0.0.1:3003/agents/chatgpt-auth/callback');
    const url = new URL(first.authorizeUrl);

    expect(`${url.origin}${url.pathname}`).toBe(CHATGPT_AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe(CHATGPT_DYNAMIC_CLIENT_ID);
    expect(url.searchParams.get('agent_name_hint')).toBe(CHATGPT_AGENT_NAME_HINT);
    expect(url.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);
    expect(url.searchParams.get('scope')).toBe(CHATGPT_OAUTH_SCOPES);
    expect(url.searchParams.get('resource')).toBe(CHATGPT_API_RESOURCE);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBe(first.state);

    // Subsequent sign-in reuses the same persistent host ID.
    const second = await chatGptAuthService.startSignIn('http://127.0.0.1:3003/agents/chatgpt-auth/callback');
    const secondUrl = new URL(second.authorizeUrl);
    expect(secondUrl.searchParams.get('ext_agent_host_id')).toBe(url.searchParams.get('ext_agent_host_id'));
    expect(mockTrackEvent).toHaveBeenCalledWith(
      'chatgpt auth started',
      expect.any(String),
      { 'auth.dynamic_registration': 'true' },
    );
  });

  it('reuses saved issued client_id and omits agent_name_hint on subsequent sign-ins', async () => {
    store.set('chatgptAuthClientId', 'oaiapp_existing123');
    const { authorizeUrl } = await chatGptAuthService.startSignIn('http://127.0.0.1:3003/agents/chatgpt-auth/callback');
    const url = new URL(authorizeUrl);

    expect(url.searchParams.get('client_id')).toBe('oaiapp_existing123');
    expect(url.searchParams.get('agent_name_hint')).toBeNull();
  });

  it('exchanges callback code, persists issued client_id + tokens, and exposes signed-in status', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          scope: CHATGPT_OAUTH_SCOPES,
          id_token: makeIdToken({ email: 'user@example.com' }),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock;

    const { state } = await chatGptAuthService.startSignIn('http://127.0.0.1:3003/agents/chatgpt-auth/callback');
    const status = await chatGptAuthService.handleCallback({
      code: 'auth-code-123',
      state,
      clientId: 'oaiapp_issued456',
    });

    expect(status.signedIn).toBe(true);
    expect(status.email).toBe('user@example.com');
    expect(store.get('chatgptAuthClientId')).toBe('oaiapp_issued456');
    expect(await chatGptAuthService.getAccessToken()).toBe('access-1');

    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0];
    expect(tokenUrl).toBe(CHATGPT_TOKEN_URL);
    const body = tokenInit.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('oaiapp_issued456');
    expect(body.get('code')).toBe('auth-code-123');
    expect(body.get('code_verifier')).toBeTruthy();

    expect(mockTrackEvent).toHaveBeenCalledWith(
      'chatgpt auth succeeded',
      expect.any(String),
      { 'auth.dynamic_registration': 'true', 'auth.has_refresh_token': 'true' },
    );
  });

  it('rejects callback when state is unknown or reused', async () => {
    await expect(
      chatGptAuthService.handleCallback({ code: 'abc', state: 'bogus' }),
    ).rejects.toThrow(ChatGptAuthError);
  });

  it('rejects token response when chatgpt.tokens.use.direct scope was not granted', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-no-scope',
          expires_in: 3600,
          scope: 'openid profile email',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const { state } = await chatGptAuthService.startSignIn('http://127.0.0.1:3003/agents/chatgpt-auth/callback');
    await expect(
      chatGptAuthService.handleCallback({ code: 'code-1', state, clientId: 'oaiapp_1' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(chatGptAuthService.isSignedIn()).toBe(false);
  });

  it('coalesces concurrent token refreshes into a single refresh request', async () => {
    store.set('chatgptAuthClientId', 'oaiapp_refresh');
    store.set(
      'chatgptAuthTokens',
      JSON.stringify({
        accessToken: 'expired-access',
        refreshToken: 'refresh-old',
        expiresAt: Date.now() - 1000,
        scope: CHATGPT_DIRECT_USAGE_SCOPE,
        email: 'user@example.com',
      }),
    );
    await chatGptAuthService.load();

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'fresh-access',
          refresh_token: 'refresh-new',
          expires_in: 3600,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    globalThis.fetch = fetchMock;

    const [t1, t2] = await Promise.all([
      chatGptAuthService.getAccessToken(),
      chatGptAuthService.getAccessToken(),
    ]);

    expect(t1).toBe('fresh-access');
    expect(t2).toBe('fresh-access');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('clears tokens on 401 refresh failure while keeping host ID and client ID', async () => {
    store.set('chatgptAuthHostId', 'urn:uuid:host-1');
    store.set('chatgptAuthClientId', 'oaiapp_keep');
    store.set(
      'chatgptAuthTokens',
      JSON.stringify({
        accessToken: 'expired-access',
        refreshToken: 'revoked-refresh',
        expiresAt: Date.now() - 1000,
        scope: CHATGPT_DIRECT_USAGE_SCOPE,
        email: 'user@example.com',
      }),
    );
    await chatGptAuthService.load();

    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
    );

    await expect(chatGptAuthService.getAccessToken()).rejects.toThrow(ChatGptAuthError);
    expect(chatGptAuthService.isSignedIn()).toBe(false);
    expect(store.get('chatgptAuthHostId')).toBe('urn:uuid:host-1');
    expect(store.get('chatgptAuthClientId')).toBe('oaiapp_keep');
    expect(store.has('chatgptAuthTokens')).toBe(false);
  });

  it('signOut clears tokens but preserves host ID and issued client ID', async () => {
    store.set('chatgptAuthHostId', 'urn:uuid:host-1');
    store.set('chatgptAuthClientId', 'oaiapp_keep');
    store.set(
      'chatgptAuthTokens',
      JSON.stringify({
        accessToken: 'live-access',
        refreshToken: 'refresh-1',
        expiresAt: Date.now() + 600_000,
        scope: CHATGPT_DIRECT_USAGE_SCOPE,
        email: 'user@example.com',
      }),
    );
    await chatGptAuthService.load();
    expect(chatGptAuthService.isSignedIn()).toBe(true);

    const after = await chatGptAuthService.signOut();
    expect(after.signedIn).toBe(false);
    expect(store.get('chatgptAuthHostId')).toBe('urn:uuid:host-1');
    expect(store.get('chatgptAuthClientId')).toBe('oaiapp_keep');
    expect(store.has('chatgptAuthTokens')).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledWith('chatgpt auth signed out', expect.any(String), {});
  });
});
