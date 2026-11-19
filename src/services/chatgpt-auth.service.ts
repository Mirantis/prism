/**
 * Sign in with ChatGPT (OAuth 2.0 Authorization Code + PKCE) for `LLM_PROVIDER=chatgpt`.
 *
 * Uses OpenAI's official dynamic agent client registration flow (`client_id=dynamic_agent_client`
 * on first sign-in with `agent_name_hint=Prism` and a persistent `ext_agent_host_id`), then
 * persists the issued `oaiapp_...` client ID and tokens locally in SQLite (`runtime_state`).
 * Access tokens are scoped for `https://api.openai.com/v1` with `chatgpt.tokens.use.direct` so
 * Prism calls the public OpenAI Responses API under the user's ChatGPT subscription allowance.
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { config } from '../config';
import { logger } from '../logger';
import { trackEvent } from '../lib/telemetry';
import {
  CHATGPT_AUTH_CLIENT_ID,
  CHATGPT_AUTH_HOST_ID,
  CHATGPT_AUTH_TOKENS,
  runtimeStateService,
} from './runtime-state.service';

export const CHATGPT_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const CHATGPT_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
export const CHATGPT_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const CHATGPT_AGENT_NAME_HINT = 'Prism';
export const CHATGPT_API_RESOURCE = 'https://api.openai.com/v1';
export const CHATGPT_DIRECT_USAGE_SCOPE = 'chatgpt.tokens.use.direct';
export const CHATGPT_OAUTH_SCOPES = [
  'openid',
  'profile',
  'email',
  'offline_access',
  'resource.invoke',
  CHATGPT_DIRECT_USAGE_SCOPE,
].join(' ');

/** Refresh the access token this many milliseconds before it expires. */
const EXPIRY_BUFFER_MS = 60_000;

/** Pending browser PKCE attempts expire after 15 minutes. */
export const CHATGPT_PENDING_TTL_MS = 15 * 60_000;
const MAX_PENDING_ATTEMPTS = 20;

export interface StoredChatGptTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scope: string | null;
  email: string | null;
}

export interface ChatGptAuthStatus {
  enabled: boolean;
  signedIn: boolean;
  email: string | null;
  expiresAt: number | null;
}

export interface ChatGptSignInStart {
  authorizeUrl: string;
}

export interface ChatGptCallbackParams {
  code?: string;
  state?: string;
  clientId?: string;
  error?: string;
  errorDescription?: string;
}

export class ChatGptAuthError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'ChatGptAuthError';
  }
}

interface PendingAttempt {
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  isDynamicRegistration: boolean;
  generation: number;
  createdAt: number;
}

interface TokenEndpointResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  id_token?: string;
  client_id?: string;
  error?: string;
  error_description?: string;
}

let cachedTokens: StoredChatGptTokens | null = null;
let cachedClientId: string | null = null;
let sessionGeneration = 0;
let refreshInFlight: Promise<string> | null = null;
let persistChain: Promise<void> = Promise.resolve();
const pendingAttempts = new Map<string, PendingAttempt>();

function enqueuePersist(op: () => Promise<void>): Promise<void> {
  const next = persistChain.then(op, op);
  persistChain = next.catch(() => {});
  return next;
}

function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function pruneExpiredPending(now = Date.now()): void {
  for (const [state, attempt] of pendingAttempts) {
    if (now - attempt.createdAt > CHATGPT_PENDING_TTL_MS) {
      pendingAttempts.delete(state);
    }
  }
}

/** Extract display email from an OIDC ID token payload without logging or persisting the raw JWT. */
function emailFromIdToken(idToken: string | undefined): string | null {
  if (!idToken) return null;
  const parts = idToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { email?: unknown };
    return typeof payload.email === 'string' && payload.email.trim() ? payload.email.trim() : null;
  } catch {
    return null;
  }
}

function parseStoredTokens(raw: string | null): StoredChatGptTokens | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredChatGptTokens>;
    if (typeof parsed.accessToken !== 'string' || !parsed.accessToken) return null;
    if (typeof parsed.expiresAt !== 'number' || !Number.isFinite(parsed.expiresAt)) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === 'string' && parsed.refreshToken ? parsed.refreshToken : null,
      expiresAt: parsed.expiresAt,
      scope: typeof parsed.scope === 'string' ? parsed.scope : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
    };
  } catch {
    return null;
  }
}

async function getOrCreateHostId(): Promise<string> {
  const existing = await runtimeStateService.get(CHATGPT_AUTH_HOST_ID);
  if (existing) return existing;
  const created = `urn:uuid:${randomUUID()}`;
  await runtimeStateService.set(CHATGPT_AUTH_HOST_ID, created);
  return created;
}

async function loadClientId(): Promise<string | null> {
  if (cachedClientId) return cachedClientId;
  const stored = await runtimeStateService.get(CHATGPT_AUTH_CLIENT_ID);
  cachedClientId = stored || null;
  return cachedClientId;
}

/**
 * Persist tokens (and optionally an issued client ID) only if `expectedGeneration`
 * is still current. Returns false when a newer sign-out or sign-in superseded it.
 */
async function commitTokensIfCurrent(
  expectedGeneration: number,
  tokens: StoredChatGptTokens,
  issuedClientId?: string,
  expectedTokens?: StoredChatGptTokens | null,
  advanceGeneration = false,
): Promise<boolean> {
  let committed = false;
  await enqueuePersist(async () => {
    if (sessionGeneration !== expectedGeneration) return;
    if (expectedTokens !== undefined && cachedTokens !== expectedTokens) return;
    if (issuedClientId) {
      cachedClientId = issuedClientId;
      await runtimeStateService.set(CHATGPT_AUTH_CLIENT_ID, issuedClientId);
    }
    if (sessionGeneration !== expectedGeneration) return;
    cachedTokens = tokens;
    if (advanceGeneration) {
      sessionGeneration += 1;
    }
    await runtimeStateService.set(CHATGPT_AUTH_TOKENS, JSON.stringify(tokens));
    committed = true;
  });
  return committed;
}

async function clearTokensIfCurrent(
  expectedGeneration?: number,
  expectedTokens?: StoredChatGptTokens | null,
): Promise<void> {
  await enqueuePersist(async () => {
    if (expectedGeneration !== undefined && sessionGeneration !== expectedGeneration) return;
    if (expectedTokens !== undefined && cachedTokens !== expectedTokens) return;
    cachedTokens = null;
    await runtimeStateService.delete(CHATGPT_AUTH_TOKENS);
  });
}

export const chatGptAuthService = {
  /**
   * Load persisted ChatGPT OAuth state into memory at boot so `isSignedIn()`
   * and `missingProviderSettings()` answer synchronously.
   */
  async load(): Promise<void> {
    try {
      const [rawTokens, clientId] = await Promise.all([
        runtimeStateService.get(CHATGPT_AUTH_TOKENS),
        runtimeStateService.get(CHATGPT_AUTH_CLIENT_ID),
      ]);
      cachedTokens = parseStoredTokens(rawTokens);
      cachedClientId = clientId || null;
    } catch (err) {
      logger.warn({ err }, '[ChatGptAuth] could not load persisted auth state');
    }
  },

  /** Synchronous check used by `missingProviderSettings()`. */
  isSignedIn(): boolean {
    if (!cachedTokens) return false;
    return Boolean(
      (cachedTokens.refreshToken && cachedClientId) || cachedTokens.expiresAt > Date.now(),
    );
  },

  status(): ChatGptAuthStatus {
    const signedIn = this.isSignedIn();
    return {
      enabled: config.llmProvider === 'chatgpt',
      signedIn,
      email: signedIn ? cachedTokens?.email ?? null : null,
      expiresAt: signedIn ? cachedTokens?.expiresAt ?? null : null,
    };
  },

  /** Start a PKCE OAuth flow and return the browser authorization URL. */
  async startSignIn(redirectUri: string): Promise<ChatGptSignInStart> {
    pruneExpiredPending();
    if (pendingAttempts.size >= MAX_PENDING_ATTEMPTS) {
      const oldestKey = pendingAttempts.keys().next().value;
      if (oldestKey) pendingAttempts.delete(oldestKey);
    }

    const [hostId, savedClientId] = await Promise.all([getOrCreateHostId(), loadClientId()]);
    const isDynamicRegistration = !savedClientId;
    const clientId = savedClientId ?? CHATGPT_DYNAMIC_CLIENT_ID;

    const state = randomBytes(32).toString('hex');
    const nonce = randomBytes(32).toString('hex');
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = generateCodeChallenge(codeVerifier);

    pendingAttempts.set(state, {
      codeVerifier,
      redirectUri,
      clientId,
      isDynamicRegistration,
      generation: sessionGeneration,
      createdAt: Date.now(),
    });

    const url = new URL(CHATGPT_AUTHORIZE_URL);
    url.searchParams.set('client_id', clientId);
    if (isDynamicRegistration) {
      url.searchParams.set('agent_name_hint', CHATGPT_AGENT_NAME_HINT);
    }
    url.searchParams.set('ext_agent_host_id', hostId);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', CHATGPT_OAUTH_SCOPES);
    url.searchParams.set('resource', CHATGPT_API_RESOURCE);
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');

    trackEvent('chatgpt auth started', config.ownerUserId, {
      'auth.dynamic_registration': String(isDynamicRegistration),
    });

    return { authorizeUrl: url.toString() };
  },

  /** Complete the OAuth callback, persist issued client ID and tokens. */
  async handleCallback(params: ChatGptCallbackParams): Promise<ChatGptAuthStatus> {
    pruneExpiredPending();
    const state = params.state?.trim();
    const attempt = state ? pendingAttempts.get(state) : undefined;
    if (state) pendingAttempts.delete(state);

    if (!attempt || attempt.generation !== sessionGeneration) {
      trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'invalid_state' });
      throw new ChatGptAuthError('This sign-in link has expired or is invalid. Start sign-in again.', 400);
    }

    if (params.error) {
      trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'provider_error' });
      const detail = params.errorDescription || params.error;
      throw new ChatGptAuthError(`Sign in with ChatGPT was not completed: ${detail}`, 400);
    }

    const code = params.code?.trim();
    if (!code) {
      trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'missing_code' });
      throw new ChatGptAuthError('Missing authorization code in callback.', 400);
    }

    // Never let a query-string client_id override a previously saved client.
    const callbackClientId = attempt.isDynamicRegistration ? params.clientId?.trim() : undefined;
    const exchangeClientId = callbackClientId || attempt.clientId;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: exchangeClientId,
      code,
      redirect_uri: attempt.redirectUri,
      code_verifier: attempt.codeVerifier,
      resource: CHATGPT_API_RESOURCE,
    });

    const response = await globalThis.fetch(CHATGPT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = (await response.json().catch(() => ({}))) as TokenEndpointResponse;
    if (!response.ok || !payload.access_token) {
      trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'token_exchange_failed' });
      const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
      throw new ChatGptAuthError(`Could not complete ChatGPT sign-in (${detail}).`, 502);
    }

    if (payload.scope) {
      const granted = new Set(payload.scope.split(/\s+/).filter(Boolean));
      if (!granted.has(CHATGPT_DIRECT_USAGE_SCOPE)) {
        trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'missing_usage_scope' });
        throw new ChatGptAuthError(
          'Your ChatGPT account did not grant direct plan usage access. Check your ChatGPT plan and settings.',
          403,
        );
      }
    }

    // Prefer the client_id returned by the token endpoint; fall back to the
    // callback query value only for a dynamic registration.
    const issuedClientId = payload.client_id?.trim() || callbackClientId;
    const effectiveClientId =
      issuedClientId && issuedClientId !== CHATGPT_DYNAMIC_CLIENT_ID
        ? issuedClientId
        : !attempt.isDynamicRegistration
          ? attempt.clientId
          : null;

    if (attempt.isDynamicRegistration && !effectiveClientId) {
      trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'missing_client_id' });
      throw new ChatGptAuthError(
        'OpenAI did not return a client ID for this installation. Start sign-in again.',
        502,
      );
    }

    const expiresInSec = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600;
    const tokens: StoredChatGptTokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? null,
      expiresAt: Date.now() + expiresInSec * 1000,
      scope: payload.scope ?? null,
      email: emailFromIdToken(payload.id_token),
    };

    const committed = await commitTokensIfCurrent(
      attempt.generation,
      tokens,
      effectiveClientId && attempt.isDynamicRegistration ? effectiveClientId : undefined,
      undefined,
      true,
    );
    if (!committed) {
      trackEvent('chatgpt auth failed', config.ownerUserId, { 'auth.reason': 'superseded' });
      throw new ChatGptAuthError('Sign-in was cancelled before completion. Start sign-in again.', 409);
    }

    trackEvent('chatgpt auth succeeded', config.ownerUserId, {
      'auth.dynamic_registration': String(attempt.isDynamicRegistration),
      'auth.has_refresh_token': String(Boolean(tokens.refreshToken)),
    });

    return this.status();
  },

  /**
   * Return a valid access token, refreshing transparently when near expiry or
   * when `forceRefresh` is true (e.g. after a 401 from OpenAI).
   */
  async getAccessToken(forceRefresh = false): Promise<string> {
    if (!cachedTokens) {
      await this.load();
    }
    if (!cachedTokens) {
      throw new ChatGptAuthError('Not signed in to ChatGPT. Sign in from Profile to use your ChatGPT plan.', 401);
    }

    const needsRefresh = forceRefresh || cachedTokens.expiresAt - Date.now() <= EXPIRY_BUFFER_MS;
    if (!needsRefresh) {
      return cachedTokens.accessToken;
    }

    if (!cachedTokens.refreshToken) {
      if (forceRefresh || cachedTokens.expiresAt <= Date.now()) {
        await clearTokensIfCurrent(sessionGeneration, cachedTokens);
        throw new ChatGptAuthError('ChatGPT session expired. Please sign in again.', 401);
      }
      return cachedTokens.accessToken;
    }

    if (!refreshInFlight) {
      refreshInFlight = this.refreshAccessToken().finally(() => {
        refreshInFlight = null;
      });
    }
    return refreshInFlight;
  },

  async refreshAccessToken(): Promise<string> {
    const generation = sessionGeneration;
    const current = cachedTokens;
    const clientId = await loadClientId();
    if (!current?.refreshToken || !clientId) {
      await clearTokensIfCurrent(generation, current);
      throw new ChatGptAuthError('ChatGPT session cannot be refreshed. Please sign in again.', 401);
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: current.refreshToken,
      resource: CHATGPT_API_RESOURCE,
    });

    const response = await globalThis.fetch(CHATGPT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    const payload = (await response.json().catch(() => ({}))) as TokenEndpointResponse;
    if (!response.ok || !payload.access_token) {
      trackEvent('chatgpt auth refresh failed', config.ownerUserId, {
        'auth.status_code': String(response.status),
      });
      if (response.status === 400 || response.status === 401) {
        await clearTokensIfCurrent(generation, current);
      }
      const detail = payload.error_description || payload.error || `HTTP ${response.status}`;
      throw new ChatGptAuthError(`ChatGPT token refresh failed (${detail}). Please sign in again.`, 401);
    }

    const expiresInSec = typeof payload.expires_in === 'number' && payload.expires_in > 0 ? payload.expires_in : 3600;
    const updated: StoredChatGptTokens = {
      accessToken: payload.access_token,
      refreshToken: payload.refresh_token ?? current.refreshToken,
      expiresAt: Date.now() + expiresInSec * 1000,
      scope: payload.scope ?? current.scope,
      email: emailFromIdToken(payload.id_token) ?? current.email,
    };

    const committed = await commitTokensIfCurrent(generation, updated, undefined, current);
    if (!committed) {
      throw new ChatGptAuthError('ChatGPT session changed while refreshing. Please sign in again.', 401);
    }
    return updated.accessToken;
  },

  /** Clear stored tokens and invalidate in-flight attempts/refreshes while keeping host ID and client ID. */
  async signOut(): Promise<ChatGptAuthStatus> {
    sessionGeneration += 1;
    pendingAttempts.clear();
    cachedTokens = null;
    await clearTokensIfCurrent();
    trackEvent('chatgpt auth signed out', config.ownerUserId, {});
    return this.status();
  },

  /** Test-only reset of in-memory state. */
  _resetForTests(): void {
    cachedTokens = null;
    cachedClientId = null;
    sessionGeneration = 0;
    refreshInFlight = null;
    persistChain = Promise.resolve();
    pendingAttempts.clear();
  },
};
