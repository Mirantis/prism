/** Managed providers describe protocols, not merely compatible chat SDKs. */
type Protocol = 'openai-realtime';
type Environment = Readonly<Record<string, string | undefined>>;
interface Surface {
  protocol: Protocol;
  baseUrlEnv: string;
  apiKeyEnv: string;
}

// Order is also the legacy discovery order when Nexus supplied no provider markers.
// OpenRouter and Mantle's OpenAI-compatible HTTP routes do not expose Realtime.
const providers: Readonly<Record<string, readonly Surface[]>> = {
  openai: [{
    protocol: 'openai-realtime',
    baseUrlEnv: 'LENS_INFERENCE_OPENAI_BASE_URL',
    apiKeyEnv: 'LENS_INFERENCE_OPENAI_API_KEY',
  }],
  azure: [{
    protocol: 'openai-realtime',
    baseUrlEnv: 'LENS_INFERENCE_AZURE_OPENAI_BASE_URL',
    apiKeyEnv: 'LENS_INFERENCE_AZURE_OPENAI_API_KEY',
  }],
  bedrock: [],
  'bedrock-mantle': [],
  openrouter: [],
};

export interface RealtimeConfiguration {
  url?: string;
  apiKey?: string;
  source: 'explicit' | 'managed' | 'direct' | 'unavailable';
  provider?: string;
  unavailableReason?: string;
}

function providerOrder(env: Environment): string[] {
  const primary = env.LENS_MANAGED_INFERENCE_PROVIDER;
  const list = env.LENS_MANAGED_INFERENCE_PROVIDERS;
  if (!primary && !list) return Object.keys(providers);
  const parsed: unknown = list ? JSON.parse(list) : [];
  if (!Array.isArray(parsed) || !parsed.every((value): value is string => typeof value === 'string')) {
    throw new Error('LENS_MANAGED_INFERENCE_PROVIDERS must be a JSON array of provider IDs');
  }
  return [...new Set([...(primary ? [primary] : []), ...parsed])];
}

function realtimeUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.protocol = 'ws:';
  else throw new Error('Managed Realtime requires HTTPS, or HTTP on loopback');
  url.pathname = url.pathname.replace(/\/+$/, '') + '/realtime';
  return url.toString();
}

/** Managed placeholders are scoped to Nexus paths, never direct provider hosts. */
function isManagedCredential(key: string, env: Environment): boolean {
  return /^__(?:lens|nexus)_cred:nexus-llm(?:-|__)/.test(key)
    || Object.entries(env).some(([name, value]) => name.startsWith('LENS_INFERENCE_')
      && /(?:API_KEY|AUTH_TOKEN|BEARER_TOKEN)$/.test(name) && value === key);
}

function isDirectBase(base: string | undefined): boolean {
  if (!base) return true;
  try {
    const url = new URL(base);
    return url.origin === 'https://api.openai.com' && url.pathname.replace(/\/+$/, '') === '/v1';
  } catch {
    return false;
  }
}

/** Resolve voice independently of chat, keeping each endpoint and credential paired. */
export function resolveRealtimeConfiguration(env: Environment): RealtimeConfiguration {
  if (env.OPENAI_REALTIME_URL) {
    let apiKey = env.OPENAI_REALTIME_API_KEY || env.OPENAI_API_KEY || undefined;
    // Explicit routing may use managed placeholders on Nexus, but never send
    // those placeholders to the direct OpenAI host.
    if (apiKey && new URL(env.OPENAI_REALTIME_URL).hostname === 'api.openai.com'
      && isManagedCredential(apiKey, env)) apiKey = undefined;
    return {
      source: 'explicit', url: env.OPENAI_REALTIME_URL, apiKey,
      ...(!apiKey ? { unavailableReason: 'Set OPENAI_REALTIME_API_KEY for the configured voice endpoint.' } : {}),
    };
  }

  for (const provider of providerOrder(env)) {
    for (const surface of Object.hasOwn(providers, provider) ? providers[provider]! : []) {
      if (surface.protocol !== 'openai-realtime') continue;
      const base = env[surface.baseUrlEnv];
      const apiKey = env[surface.apiKeyEnv];
      if (base && apiKey) return { source: 'managed', provider, url: realtimeUrl(base), apiKey };
    }
  }

  // A dedicated voice key can serve direct OpenAI even when chat is managed.
  // Shared chat credentials are only eligible in a standalone direct setup.
  const managed = Boolean(env.LENS_MANAGED_INFERENCE_PROVIDER || env.LENS_MANAGED_INFERENCE_PROVIDERS
    || Object.keys(env).some((key) => key.startsWith('LENS_INFERENCE_') && env[key]));
  const apiKey = env.OPENAI_REALTIME_API_KEY
    || (!managed && isDirectBase(env.OPENAI_BASE_URL) ? env.OPENAI_API_KEY : undefined);
  if (apiKey && !isManagedCredential(apiKey, env)) return { source: 'direct', provider: 'openai', apiKey };
  return {
    source: 'unavailable',
    unavailableReason: 'Voice needs a managed Realtime endpoint with its credential, or OPENAI_REALTIME_API_KEY for direct OpenAI. Use OPENAI_REALTIME_URL to select another voice endpoint.',
  };
}
