/**
 * ChatGPT Subscription Provider for Vercel AI SDK (`LLM_PROVIDER=chatgpt`).
 *
 * Speaks the public OpenAI Responses API at `https://api.openai.com/v1` using
 * OAuth 2.0 + PKCE tokens obtained via OpenAI's official Sign in with ChatGPT
 * flow (`chatgpt-auth.service.ts`). Reuses `createOpenAiCompatibleProvider` so
 * prompt caching, deferred tools, and GPT-5.x classification gate rules stay
 * identical to the `openai` provider.
 */

import type { LanguageModelMiddleware } from 'ai';
import { logger } from '../../../logger';
import {
  CHATGPT_API_RESOURCE,
  chatGptAuthService,
} from '../../../services/chatgpt-auth.service';
import {
  OPENAI_DEFERRED_TOOLS,
  deferredToolsWhen,
  supportsOpenAiDeferredTools,
} from '../deferred-tools';
import { openAiCacheRequest, openAiCacheTtlMs } from '../openai/openai-provider';
import { createOpenAiCompatibleProvider } from '../openai-compatible';
import { STREAM_ONLY } from './stream-only';
import { mergeProviderOptions, type LlmProvider } from '../llm-provider';

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

/**
 * Custom fetch that injects the current Sign in with ChatGPT bearer token and
 * retries once with a forced refresh on 401.
 */
async function chatGptFetch(input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit): Promise<Response> {
  const token = await chatGptAuthService.getAccessToken();
  const first = await globalThis.fetch(input, withBearer(init, token));
  if (first.status !== 401) return first;

  // Discard the 401 body before retrying with a freshly rotated token.
  await first.body?.cancel().catch(() => {});
  const refreshed = await chatGptAuthService.getAccessToken(true);
  return globalThis.fetch(input, withBearer(init, refreshed));
}

// A ChatGPT subscription token is refused for stored responses, so every call
// sends `store: false`; the SDK then asks for the reasoning back encrypted.
const NO_STORE: LanguageModelMiddleware = {
  transformParams: async ({ params }) => ({
    ...params,
    providerOptions: mergeProviderOptions(params.providerOptions, { openai: { store: false } }),
  }),
};

export function createChatGptProvider(baseURL: string = CHATGPT_API_RESOURCE): LlmProvider {
  logger.info({ routing: 'direct' }, 'Creating ChatGPT subscription provider');

  const provider = createOpenAiCompatibleProvider({
    // The real OAuth bearer token is injected per request by `chatGptFetch`.
    apiKey: 'chatgpt-oauth',
    baseURL,
    fetch: chatGptFetch,
    // The endpoint also answers only streamed requests.
    middleware: [NO_STORE, STREAM_ONLY],
  });

  return Object.assign(provider, {
    deferredTools: deferredToolsWhen(supportsOpenAiDeferredTools, OPENAI_DEFERRED_TOOLS),
    cacheRequest: openAiCacheRequest,
    cacheTtlMs: openAiCacheTtlMs,
  });
}

/** Empty when the user has signed in with ChatGPT; otherwise names what is missing. */
export function missingChatGptSettings(): string[] {
  return chatGptAuthService.isSignedIn() ? [] : ['ChatGPT sign-in'];
}
