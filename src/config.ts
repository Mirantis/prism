import { hasBedrockCredentials } from './lib/coding-agents/bedrock-credentials';
import { hasClaudeCodeCredentials } from './lib/coding-agents/claude-code/credentials';
import path from 'path';
import sea from 'node:sea';
import dotenv from 'dotenv';
import {
  ATTACHMENT_CONTENT_TTL_HOURS,
  TOOL_OUTPUT_TTL_HOURS,
  COMPACTION_TAIL_MESSAGES,
  COMPACTION_THRESHOLD_PERCENT,
  GOAL_MAX_TURNS,
} from './constants';
import { readAgentModelDefaults } from './lib/prism-settings';
import { logger } from './logger';

// In SEA (the packaged prism-server binary), the source tree is gone — the
// sidecar `.env` lives next to the executable (e.g. ~/.prism/.env). In dev,
// __dirname is `src/` and `.env` sits at the repo root.
const dotenvPath = sea.isSea()
  ? path.join(path.dirname(process.execPath), '.env')
  : path.resolve(__dirname, '../.env');
// `quiet: true` suppresses dotenv's stdout tip line — keeps stdout clean for
// any consumer that redirects it (e.g. pino via LOG_FILE). The load summary is
// re-emitted through pino in `index.ts`.
// `dotenv.config` returns undefined when stubbed in tests; guard accordingly.
const dotenvResult = dotenv.config({ path: dotenvPath, quiet: true });

export const dotenvLoadInfo = {
  path: dotenvPath,
  loadedCount: dotenvResult?.parsed ? Object.keys(dotenvResult.parsed).length : 0,
  error: dotenvResult?.error,
};

/**
 * Centralized configuration — single place for all env var reads.
 */

const nexusApiUrl = process.env.NEXUS_API_URL;
const projectId = process.env.PROJECT_ID;
const awsRegion = process.env.AWS_REGION || 'us-east-1';

// Which vendor the runtime talks to. One provider per container (matching one
// AGENT_ID per container). Anything unrecognized falls back to the default,
// `bedrock`, so an unset/typo'd value never silently breaks a Bedrock
// deployment.
const LLM_PROVIDERS = [
  'bedrock',
  'azure',
  'bedrock-mantle',
  'openai',
  'openrouter',
  'anthropic',
] as const;
type LlmProviderName = (typeof LLM_PROVIDERS)[number];
const rawLlmProvider = (process.env.LLM_PROVIDER || '').trim().toLowerCase();
const llmProvider: LlmProviderName = (LLM_PROVIDERS as readonly string[]).includes(rawLlmProvider)
  ? (rawLlmProvider as LlmProviderName)
  : 'bedrock';

// Lens Agents LLM proxy base URL for native Bedrock (bedrock-runtime). Mirrors
// the gateway's route mounts:
//   /projects/{projectId}/llm/bedrock/{region}  (explicit project — PROJECT_ID set)
//   /llm/bedrock/{region}                        (auto-resolve project — PROJECT_ID unset)
// null when NEXUS_API_URL itself is unset (callers route direct to Bedrock
// instead of going through the gateway). This mount also carries the `bedrock`
// embedding provider's leg (Titan lives on bedrock-runtime), so on
// `bedrock-mantle` it stays in use even though chat rides
// `nexusBedrockMantleBaseUrl`.
const nexusLlmBaseUrl = nexusApiUrl
  ? (projectId
      ? `${nexusApiUrl}/projects/${projectId}/llm/bedrock/${awsRegion}`
      : `${nexusApiUrl}/llm/bedrock/${awsRegion}`)
  : null;

// Lens Agents LLM proxy base URLs for Azure. Mirrors the Bedrock route mount
// above (`nexusLlmBaseUrl`), swapping the vendor segment. The gateway exposes
// the two Foundry surfaces separately (`…/llm/azure/anthropic/{path}` → the resource's
// `/anthropic` surface; `…/llm/azure/openai/{path}` → its `/openai` surface):
//   /projects/{projectId}/llm/azure/…  (explicit project — PROJECT_ID set)
//   /llm/azure/…                        (auto-resolve project — PROJECT_ID unset)
// The anthropic SDK appends `/messages` to its base and the azure SDK appends
// `/embeddings` to a custom base, so both bases end at `/v1` for the proxied
// URLs to land on `…/anthropic/v1/messages` and `…/openai/v1/embeddings`.
// null when NEXUS_API_URL is unset (callers talk to Foundry directly).
const nexusAzureRoot = nexusApiUrl
  ? (projectId
      ? `${nexusApiUrl}/projects/${projectId}/llm/azure`
      : `${nexusApiUrl}/llm/azure`)
  : null;
const nexusAzureBaseUrl = nexusAzureRoot ? `${nexusAzureRoot}/anthropic/v1` : null;
const nexusAzureOpenAiBaseUrl = nexusAzureRoot ? `${nexusAzureRoot}/openai/v1` : null;

// Lens Agents LLM proxy base URL for bedrock-mantle's Anthropic surface,
// mounted as `…/llm/bedrock-mantle/anthropic/{region}/{path}` and
// forwarded verbatim to `https://bedrock-mantle.{region}.api.aws/anthropic/{path}`.
// Ends at `/v1` because the anthropic SDK appends `/messages`, so the proxied
// URL lands on `…/anthropic/v1/messages`. Keyless — the gateway holds the
// Bedrock credential. Mantle serves no embeddings, so there is no second mount
// here; those ride `nexusLlmBaseUrl` (bedrock-runtime) instead.
// null when NEXUS_API_URL is unset (callers talk to mantle directly).
const nexusBedrockMantleBaseUrl = nexusApiUrl
  ? (projectId
      ? `${nexusApiUrl}/projects/${projectId}/llm/bedrock-mantle/anthropic/${awsRegion}/v1`
      : `${nexusApiUrl}/llm/bedrock-mantle/anthropic/${awsRegion}/v1`)
  : null;

// Lens Agents LLM proxy base URL for OpenAI, mounted as `…/llm/openai/{path}`
// and forwarded verbatim to the gateway's configured
// OpenAI root (`https://api.openai.com` unless the operator points it at an
// OpenAI-compatible endpoint). Ends at `/v1` because the openai SDK appends
// `/responses`, `/chat/completions` or `/embeddings` to its base, so the
// proxied URL lands on `…/v1/responses` etc. One mount carries chat,
// classification *and* embeddings — OpenAI has no split surface. Keyless —
// the gateway injects the API key on the outbound leg. Note the Realtime
// WebSocket is NOT served here (the mount routes POST only); voice meetings
// keep their pinned direct socket (`services/meeting/openai-endpoint.ts`).
// null when NEXUS_API_URL is unset (callers talk to api.openai.com directly).
const nexusOpenAiBaseUrl = nexusApiUrl
  ? (projectId
      ? `${nexusApiUrl}/projects/${projectId}/llm/openai/v1`
      : `${nexusApiUrl}/llm/openai/v1`)
  : null;

// Lens Agents LLM proxy base URL for OpenRouter, mounted as
// `…/llm/openrouter/openai/{path}`. OpenRouter's own API is OpenAI-compatible,
// so this speaks the same protocol as the `openai` mount — only the mount and
// the model-id convention differ. Ends at `/v1` because the openai SDK appends
// `/responses`, `/chat/completions` or `/embeddings` to its base. Keyless: the
// gateway injects the OpenRouter key on the outbound leg, and it must be THIS
// mount rather than `/llm/openai/*` — the managed-inference gate compares the
// path's backend against the policy's and answers 403 on a mismatch.
// null when NEXUS_API_URL is unset (nothing to route through).
const nexusOpenRouterBaseUrl = nexusApiUrl
  ? (projectId
      ? `${nexusApiUrl}/projects/${projectId}/llm/openrouter/openai/v1`
      : `${nexusApiUrl}/llm/openrouter/openai/v1`)
  : null;

// The selected vendor's gateway *chat* mount, resolved once so callers that
// only need "is chat routed through the gateway?" (the startup log, startup
// telemetry) don't each re-derive the per-vendor branch. null → chat goes direct.
const nexusChatBaseUrl =
  llmProvider === 'azure'
    ? nexusAzureBaseUrl
    : llmProvider === 'bedrock-mantle'
      ? nexusBedrockMantleBaseUrl
      : llmProvider === 'openai'
        ? nexusOpenAiBaseUrl
        : llmProvider === 'openrouter'
          ? nexusOpenRouterBaseUrl
          : llmProvider === 'anthropic'
            ? // No gateway mount serves api.anthropic.com — anthropic chat is
              // always direct, even with NEXUS_API_URL set. Explicit rather
              // than the fall-through, which would report the bedrock mount.
              null
            : nexusLlmBaseUrl;

// Scheme, host and port of an http(s) URL; undefined for anything else, so a
// value that is unset, unparseable or of another scheme never matches. Two
// opaque URLs both take the origin `"null"`, which would compare equal.
const originOf = (url: string | undefined | null): string | undefined => {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return undefined;
    return parsed.origin;
  } catch {
    return undefined;
  }
};

// The gateway's own origin. The credential decision turns on one question: does
// this request reach the gateway, which injects the vendor key on the outbound
// leg? An explicit `*_BASE_URL` may point anywhere, so the origins are compared.
const nexusOrigin = originOf(nexusApiUrl);

/**
 * Whether the Lens Agents gateway serves `url`, and so holds the vendor
 * credential for it. `URL.origin` lowercases the host and drops a default port,
 * and it ignores the path, so any mount on the gateway host matches. An unset or
 * unparseable value on either side answers false: such an endpoint fails in
 * `fetch` regardless, and the SDK then reports the missing key itself.
 */
export function isGatewayEndpoint(url: string | undefined | null): boolean {
  const origin = originOf(url);
  return Boolean(nexusOrigin && origin === nexusOrigin);
}

// Azure's direct Foundry Anthropic endpoint: the explicit override, else the one
// derived from the resource name. It must end at `/anthropic/v1` — the anthropic
// SDK appends `/messages`.
//
// The override and the derived host each keep their own constant, since
// `azureChatEndpoint` below puts the gateway mount between them.
const azureResourceName = process.env.AZURE_RESOURCE_NAME;
const azureFoundryOverride = process.env.AZURE_FOUNDRY_BASE_URL || undefined;
const azureResourceEndpoint = azureResourceName
  ? `https://${azureResourceName}.services.ai.azure.com/anthropic/v1`
  : undefined;
const azureDirectEndpoint = azureFoundryOverride || azureResourceEndpoint;

// The Bedrock API key. The @ai-sdk/amazon-bedrock SDK reads this straight from
// process.env for the native Bedrock path, but mantle's Anthropic surface needs
// it explicitly (sent as `x-api-key`), so it comes through config too. May be a
// `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire.
const bedrockApiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;

// Bedrock Mantle's direct chat endpoint. Must end at `/anthropic/v1` — the
// anthropic SDK appends `/messages`. The override mirrors AZURE_FOUNDRY_BASE_URL
// and is split from the derived host for the same reason.
const bedrockMantleOverride = process.env.BEDROCK_MANTLE_BASE_URL || undefined;
const bedrockMantleRegionEndpoint = `https://bedrock-mantle.${awsRegion}.api.aws/anthropic/v1`;
const bedrockMantleDirectEndpoint = bedrockMantleOverride || bedrockMantleRegionEndpoint;

// Resolved once so the vendor-specific fields and the provider-neutral
// `chatModelId`/`classificationModelId`/`embeddingModelId` (the last keyed
// off the embedding provider, further below) share one source.
// The chat and classification defaults use the `global.` inference profile: it
// costs less than a regional one (AWS charges 10% more for `us.`/`eu.`/`au.`)
// and has the same context and output limits. Mantle IDs stay unprefixed.
const bedrockModelId = process.env.BEDROCK_MODEL_ID || 'global.anthropic.claude-opus-5';
const bedrockClassificationModelId =
  process.env.BEDROCK_CLASSIFICATION_MODEL_ID || 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const bedrockEmbeddingModelId = process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0';
// Azure model IDs are deployment names. Chat/classification default to
// Foundry's default Claude deployment names; embeddings default to an Azure
// OpenAI text-embedding-3 deployment (like Bedrock defaults to Titan). The
// embedding deployment must exist on the resource — if it doesn't, memory
// embedding fails open (the SDK call errors and is swallowed → no vector);
// set AZURE_EMBEDDING_MODEL_ID='' to skip embedding entirely.
const azureModelId = process.env.AZURE_MODEL_ID || 'claude-opus-5';
const azureClassificationModelId = process.env.AZURE_CLASSIFICATION_MODEL_ID || 'claude-haiku-4-5';
const azureEmbeddingModelId = process.env.AZURE_EMBEDDING_MODEL_ID ?? 'text-embedding-3-small';
// Bedrock Mantle model IDs are plain Bedrock IDs, but *bare*: mantle does not
// support cross-region inference profiles, so a `us.`/`eu.`/`global.` prefix is
// rejected with a 400. Hence these deliberately do NOT fall back to the
// BEDROCK_* vars — that would import a prefixed value mantle can't serve.
// (The provider also strips the prefix at dispatch, for per-agent overrides.)
// Mantle serves no embedding models at all, so embeddings stay on Titan over
// bedrock-runtime and default to the same model as the Bedrock provider;
// `??` so BEDROCK_MANTLE_EMBEDDING_MODEL_ID='' disables them entirely, matching
// AZURE_EMBEDDING_MODEL_ID.
// Note the classification default carries no `-20251001-v1:0` version suffix
// either: that is a bedrock-runtime convention, and mantle 404s it
// ("The model 'anthropic.claude-haiku-4-5-20251001-v1:0' does not exist").
const bedrockMantleModelId = process.env.BEDROCK_MANTLE_MODEL_ID || 'anthropic.claude-opus-5';
const bedrockMantleClassificationModelId =
  process.env.BEDROCK_MANTLE_CLASSIFICATION_MODEL_ID || 'anthropic.claude-haiku-4-5';
const bedrockMantleEmbeddingModelId =
  process.env.BEDROCK_MANTLE_EMBEDDING_MODEL_ID ?? bedrockEmbeddingModelId;
// OpenAI model IDs (used when LLM_PROVIDER=openai). Chat defaults to the
// GPT-5.6 flagship; classification to the fast tier — the provider pins the
// gates to `reasoningEffort: 'none'` and omits their temperature param (see
// openai-provider.ts), which is what keeps the gates' tiny token budgets
// valid on a GPT-5.x model. Embeddings are truncated to 1024 dims by
// embedding.service to fit the sqlite-vec index; `??` so
// OPENAI_EMBEDDING_MODEL_ID='' disables them entirely, matching
// AZURE_EMBEDDING_MODEL_ID.
const openaiModelId = process.env.OPENAI_MODEL_ID || 'gpt-5.6-sol';
const openaiClassificationModelId = process.env.OPENAI_CLASSIFICATION_MODEL_ID || 'gpt-5.6-luna';
const openaiEmbeddingModelId = process.env.OPENAI_EMBEDDING_MODEL_ID ?? 'text-embedding-3-small';
// OpenRouter model IDs (used when LLM_PROVIDER=openrouter). Every id it routes is
// `vendor/model`, so the bare ids above — correct against api.openai.com — are
// not models it can resolve. Defaults mirror the OpenAI tier choices so the
// provider's GPT-5.x parameter handling (pinned `reasoningEffort`, no
// temperature on the gates) stays valid; point them at any vendor's models
// instead and those assumptions may not hold.
//
// Embeddings default to OFF, unlike the sibling vendors. OpenRouter serves an
// `/embeddings` endpoint routing several vendors' models, whose native
// dimensionalities differ — and the memory index is fixed at 1024 dims, so
// there is no id that is right by default. Name one that can deliver 1024
// (`openai/text-embedding-3-small` truncates to it) to switch memory embeddings
// on. `??` not `||`, matching the sibling vars, so '' keeps them off
// explicitly.
const openrouterModelId = process.env.OPENROUTER_MODEL_ID || 'openai/gpt-5.6-sol';
const openrouterClassificationModelId =
  process.env.OPENROUTER_CLASSIFICATION_MODEL_ID || 'openai/gpt-5.6-luna';
const openrouterEmbeddingModelId = process.env.OPENROUTER_EMBEDDING_MODEL_ID ?? '';
// OpenRouter's own endpoint, spelled out because the SDK's default is
// api.openai.com, which is not where a `vendor/model` id resolves.
const OPENROUTER_DIRECT_BASE_URL = 'https://openrouter.ai/api/v1';
// OpenRouter endpoint override, mirroring OPENAI_BASE_URL. It outranks the
// gateway mount (see `openrouterEndpoint` below). Must serve the Responses API
// — the SDK appends `/responses`, which openrouter.ai serves alongside
// `/chat/completions`.
const openrouterOverride = process.env.OPENROUTER_BASE_URL || undefined;
// The OpenRouter API key, for direct mode. Not needed through the gateway,
// which holds its own. May be a `__nexus_cred:<uuid>__` sentinel the MITM proxy
// rewrites on the wire, since it only ever rides a header.
const openrouterApiKey = process.env.OPENROUTER_API_KEY;
// OpenAI endpoint override, mirroring AZURE_FOUNDRY_BASE_URL /
// BEDROCK_MANTLE_BASE_URL. It outranks the gateway mount (see `openaiEndpoint`
// below), and must serve the Responses API — the SDK appends `/responses`, not
// just `/chat/completions`. Does NOT move the Realtime WebSocket.
const openaiOverride = process.env.OPENAI_BASE_URL || undefined;

// The OpenAI API key, serving double duty: live voice meetings (OpenAI
// Realtime API) and, when LLM_PROVIDER=openai, the chat provider. The
// *Realtime WebSocket* is the one model call that never rides the Lens Agents
// LLM gateway — the `…/llm/openai` mount routes POST only, so the socket goes
// straight to api.openai.com. Chat/classification/
// embeddings do ride that mount when NEXUS_API_URL is set, and then need no
// local key at all (the gateway injects its own). Still credential-safe in a
// sandbox: the key may be a `__nexus_cred:<uuid>__` sentinel that the egress
// MITM swaps on the wire, and it is only ever sent as a header. Unset
// disables the meeting tools entirely (they're also gated on the browser and
// audio toolchain being present).
const openaiApiKey = process.env.OPENAI_API_KEY;

// Anthropic model IDs (used when LLM_PROVIDER=anthropic) — bare first-party
// IDs on api.anthropic.com. No embedding var: Anthropic serves no embedding
// models, so memory embeddings come from the embedding provider (OpenAI when
// OPENAI_API_KEY is set or the gateway's openai mount can hold the key, else
// disabled — see EMBEDDING_PROVIDER_DEFAULTS below).
const anthropicModelId = process.env.ANTHROPIC_MODEL_ID || 'claude-opus-5';
const anthropicClassificationModelId =
  process.env.ANTHROPIC_CLASSIFICATION_MODEL_ID || 'claude-haiku-4-5';
// The Anthropic API key, sent as the `x-api-key` header. Required — this
// vendor is direct-only (no Nexus mount serves api.anthropic.com), so there is
// no gateway to hold the credential. May be a `__nexus_cred:<uuid>__` sentinel
// the MITM proxy rewrites on the wire, since it only ever rides a header.
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
// Direct Anthropic endpoint override, mirroring OPENAI_BASE_URL. Must end at
// `/v1` — the anthropic SDK appends `/messages`.
// undefined → the SDK's own default, https://api.anthropic.com/v1.
const anthropicBaseUrl = process.env.ANTHROPIC_BASE_URL || undefined;

// The endpoint each vendor's client uses, in precedence order: the explicit
// `*_BASE_URL` override, else the gateway mount, else the vendor's own host. The
// override comes first because the operator named a host, and because the
// derived mount is otherwise the only one a gateway deployment can reach.
// Resolved here so the rule is written once and a provider factory receives an
// endpoint rather than choosing between two.
const azureChatEndpoint = azureFoundryOverride ?? nexusAzureBaseUrl ?? azureResourceEndpoint;
const bedrockMantleChatEndpoint =
  bedrockMantleOverride ?? nexusBedrockMantleBaseUrl ?? bedrockMantleRegionEndpoint;
// One endpoint per OpenAI-shaped vendor, serving chat, classification *and*
// embeddings: OPENAI_BASE_URL and OPENROUTER_BASE_URL are each one variable for
// the whole surface, so both legs follow the override together.
// `openaiEndpoint` undefined → the SDK's own default, https://api.openai.com/v1.
const openaiEndpoint = openaiOverride ?? nexusOpenAiBaseUrl ?? undefined;
const openrouterEndpoint =
  openrouterOverride ?? nexusOpenRouterBaseUrl ?? OPENROUTER_DIRECT_BASE_URL;

// The selected vendor's chat endpoint and the override that supplied it, for the
// startup log. Anthropic has no mount, so its override is its whole endpoint.
const chatEndpoints: Record<LlmProviderName, { endpoint?: string; override?: string }> = {
  bedrock: { endpoint: nexusLlmBaseUrl ?? undefined },
  azure: { endpoint: azureChatEndpoint, override: azureFoundryOverride },
  'bedrock-mantle': { endpoint: bedrockMantleChatEndpoint, override: bedrockMantleOverride },
  openai: { endpoint: openaiEndpoint, override: openaiOverride },
  openrouter: { endpoint: openrouterEndpoint, override: openrouterOverride },
  anthropic: { endpoint: anthropicBaseUrl, override: anthropicBaseUrl },
};
const chatEndpoint = chatEndpoints[llmProvider];

// Which of the three steps supplied the endpoint. `override` next to
// `chatRouting: 'nexus'` is an override that replaced a derived mount.
const chatEndpointSource: 'override' | 'gateway' | 'direct' = chatEndpoint.override
  ? 'override'
  : nexusChatBaseUrl && chatEndpoint.endpoint === nexusChatBaseUrl
    ? 'gateway'
    : 'direct';

// Origin and path only. An endpoint may carry a credential in its userinfo or
// its query string, and neither belongs in a log; a value that does not parse is
// named rather than printed, for the same reason.
const endpointForLog = (url: string | undefined | null): string => {
  if (!url) return 'vendor default';
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return 'invalid';
  }
};

// Provider-neutral model IDs, resolved once. The runtime (invoke, the
// classification gate, the per-agent model fallback) reads these so it never
// has to know which vendor is active. Embeddings resolve separately below —
// they follow the *embedding* provider, not the chat vendor.
const modelIds = {
  bedrock: {
    chat: bedrockModelId,
    classification: bedrockClassificationModelId,
  },
  azure: {
    chat: azureModelId,
    classification: azureClassificationModelId,
  },
  'bedrock-mantle': {
    chat: bedrockMantleModelId,
    classification: bedrockMantleClassificationModelId,
  },
  openai: {
    chat: openaiModelId,
    classification: openaiClassificationModelId,
  },
  openrouter: {
    chat: openrouterModelId,
    classification: openrouterClassificationModelId,
  },
  anthropic: {
    chat: anthropicModelId,
    classification: anthropicClassificationModelId,
  },
}[llmProvider];

// Which vendor serves memory embeddings. Its own selection, decoupled from
// LLM_PROVIDER: chat vendors don't all have embedding models, and an
// embedding vendor need not serve chat. `none` disables embeddings entirely
// (memory rows persist without vectors, vector search returns nothing).
const EMBEDDING_PROVIDERS = ['bedrock', 'azure-openai', 'openai', 'openrouter', 'none'] as const;
type EmbeddingProviderName = (typeof EMBEDDING_PROVIDERS)[number];

// The default when EMBEDDING_PROVIDER is unset (or unrecognized): each chat
// vendor's historical embedding vendor, so existing deployments are
// unchanged. bedrock and bedrock-mantle embed on Titan over bedrock-runtime;
// azure on its Azure OpenAI deployment; openai and openrouter on themselves
// (openrouter's embedding model id defaults to '', so it stays off until one
// is named). anthropic serves no embedding models, so it borrows OpenAI's when
// a local key is present or the gateway's openai mount can hold one
// (NEXUS_API_URL set), and otherwise runs without vectors.
const EMBEDDING_PROVIDER_DEFAULTS: Record<LlmProviderName, EmbeddingProviderName> = {
  bedrock: 'bedrock',
  azure: 'azure-openai',
  'bedrock-mantle': 'bedrock',
  openai: 'openai',
  openrouter: 'openrouter',
  anthropic: openaiApiKey || nexusOpenAiBaseUrl ? 'openai' : 'none',
};
const rawEmbeddingProvider = (process.env.EMBEDDING_PROVIDER || '').trim().toLowerCase();
const isValidEmbeddingProvider = (EMBEDDING_PROVIDERS as readonly string[]).includes(
  rawEmbeddingProvider,
);
const embeddingProvider: EmbeddingProviderName = isValidEmbeddingProvider
  ? (rawEmbeddingProvider as EmbeddingProviderName)
  : EMBEDDING_PROVIDER_DEFAULTS[llmProvider];
// Preserved for the startup warning (same pattern as invalidToolRiskGateMode):
// a typo like EMBEDDING_PROVIDER=azure keeps the derived default running, so
// nothing ever looks broken without a log line. Empty means unset — the
// documented way to ask for the default — so only a non-empty mismatch counts.
const invalidEmbeddingProvider =
  rawEmbeddingProvider === '' || isValidEmbeddingProvider ? null : rawEmbeddingProvider;

// The embedding model id, keyed off the *embedding* provider. One legacy
// carve-out: when a bedrock-mantle deployment embeds on Titan, the
// mantle-scoped var stays authoritative, so BEDROCK_MANTLE_EMBEDDING_MODEL_ID=''
// keeps disabling embeddings there.
const embeddingModelIds: Record<EmbeddingProviderName, string> = {
  bedrock:
    llmProvider === 'bedrock-mantle' ? bedrockMantleEmbeddingModelId : bedrockEmbeddingModelId,
  'azure-openai': azureEmbeddingModelId,
  openai: openaiEmbeddingModelId,
  openrouter: openrouterEmbeddingModelId,
  none: '',
};
const embeddingModelId = embeddingModelIds[embeddingProvider];

// Pinned to a snapshot rather than the `gpt-realtime` alias. The alias silently
// follows OpenAI's current snapshot, and a voice model changing under a live
// deployment shifts turn-taking and prosody with no code change to point at.
const openaiRealtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
// Where the Realtime WebSocket goes. `OPENAI_BASE_URL` does not move it — that one
// is the Responses API endpoint — so a test that needs a local voice model has no
// other way in: the runtime under test is a separate process, and the in-process
// endpoint override cannot cross that boundary. Unset means api.openai.com.
const openaiRealtimeUrl = process.env.OPENAI_REALTIME_URL || undefined;
// `marin` is markedly better for conversation than the API's `alloy` default.
// Overridable because a future model may retire a voice name.
const openaiRealtimeVoice = process.env.OPENAI_REALTIME_VOICE || 'marin';
// How hard the in-meeting model thinks before it answers or picks a tool.
//
// The API's own default is `low`, which is the right call for the voice agents
// that surface was built for — book a table, read out an order status. This one
// holds the agent's real toolset: shell, kubectl, GitHub, cron, its own
// configuration. Choosing the wrong tool there is not a clumsy sentence, it is a
// command run against a cluster, so the default here is `high` instead.
//
// It is not free. Effort buys reasoning with latency and output tokens, and in a
// call the latency is silence in a room full of people waiting — which is why the
// level is an env var and the `[Meeting:Latency]` line records the one in force.
// Drop it if the room notices the pause more than it notices the mistakes.
//
// Empty means send nothing and let the API pick, the same opt-out the embedding
// model vars use. An unrecognized level falls back to the default rather than
// failing the boot: a typo here should cost accuracy, not the meeting.
const REALTIME_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export type RealtimeReasoningEffort = (typeof REALTIME_REASONING_EFFORTS)[number];
// Trimmed and lowercased before the match: an unrecognized value falls back to
// `high`, so `Medium` or a stray trailing space from a compose file would quietly
// raise the effort of an operator who was asking to lower it.
const rawRealtimeReasoningEffort = process.env.OPENAI_REALTIME_REASONING_EFFORT?.trim()
  .toLowerCase();
const openaiRealtimeReasoningEffort: RealtimeReasoningEffort | null =
  rawRealtimeReasoningEffort === ''
    ? null
    : REALTIME_REASONING_EFFORTS.includes(rawRealtimeReasoningEffort as RealtimeReasoningEffort)
      ? (rawRealtimeReasoningEffort as RealtimeReasoningEffort)
      : 'high';
// Transcriber that exists only so a call can be read back in the log. Nothing
// decides anything from these words — the addressed gate judges the audio — so it
// is requested only when `MEETING_TRANSCRIPT_LOGGING` is `full`, and it bills per
// audio minute. `gpt-live-transcribe` is the one model that both streams and takes
// `keywords`, which seeds the agent's own name and the room's roster into the
// decoder — names are the words a speech model drops most. A model without keywords
// still works, but it garbles the names in the log.
const openaiTranscriptionModel =
  process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-live-transcribe';

// Server-side noise reduction over meeting audio, before turn detection and
// transcription see it: `off` (send no setting), `near_field`, or `far_field`.
//
// **Off by default, which is not the obvious choice.** `far_field` reads like the
// right fit — a meeting is several people at conversational distance from a laptop
// mic — but that describes the *humans'* microphones, not this input. What arrives
// here is Meet's mixed output, already noise-suppressed, echo-cancelled and
// gain-levelled per participant: a broadcast mix rather than a raw room. Reducing it
// again is a second pass over audio that has been cleaned once.
//
// The second pass was not harmless. Under `far_field` a live agent went minutes
// without reacting to a person in the room while answering the other agent's
// synthesized voice instantly — the signature of an adaptive noise floor lifted by
// loud speech, where the loud voice clears the threshold and a quieter human is
// suppressed as noise. Run side by side on the same room, the agent with reduction
// off registered seven utterances to the other's two and never idled more than ten
// seconds; the `far_field` one sat idle for 28s through speech.
//
// A meeting agent that mishears is recoverable — someone repeats themselves. One that
// cannot hear is not, so the trade favours the noisier input. `near_field` is the
// middle setting and is **untested**; reach for it before going back to `far_field`
// if a room turns out to be too noisy for the turn detector.
const noiseReduction = (() => {
  const raw = (process.env.OPENAI_NOISE_REDUCTION || 'off').trim().toLowerCase();
  return raw === 'near_field' || raw === 'far_field' ? raw : 'off';
})();

// Whether what is said in a meeting reaches the runtime's own logs: `off` or `full`.
//
// **Off by default**, and this one is not a trade-off between two goods. A meeting is
// unauthenticated — anybody in the room speaks to the agent, and nobody in the room
// agreed to anything about this deployment's logs. An utterance is third-party speech
// rather than the operator's own data, the gate sees every sentence and not just the
// ones aimed at the agent, and a log line outlives the call by whatever the log
// retention is. Writing the room's conversation there by default is the sort of
// decision that has to be made deliberately, which is what this variable is for.
//
// `full` writes the sentence itself. Reach for it in a room that knows, on a
// deployment whose logs you are willing to treat as a recording of the meeting.
//
// A variable of its own rather than a log level, which is the tempting shortcut: an
// operator raises the level to chase something unrelated — a browser failure, an audio
// drop — and under a level-gated design that would quietly start transcribing the room
// as a side effect. Recording a meeting has to be its own decision. It also means the
// words arrive without the rest of the meeting's debug noise, which is the state you
// want while diagnosing "it stopped answering to its name".
//
// An unrecognized value is `off` rather than a boot failure: a typo here should cost
// a diagnostic, not the container. `''` is `off` too — unlike
// OPENAI_REALTIME_REASONING_EFFORT, where empty means "let the API choose", there is
// nobody else to defer to.
const meetingTranscriptLogging = ((): 'off' | 'full' => {
  const raw = (process.env.MEETING_TRANSCRIPT_LOGGING || 'off').trim().toLowerCase();
  return raw === 'full' ? 'full' : 'off';
})();

// Google account the meeting bot signs in as.
//
// Not optional in practice for Google Meet: Google auto-denies automated
// *anonymous* guests (the join RPC returns 403 and the host is never even
// prompted), so a bot that isn't signed in reaches the lobby and stops there. A
// signed-in account is an ordinary participant. The browser profile is persisted
// under the data dir, so the sign-in happens once rather than per meeting —
// which also keeps Google from treating every call as a new-device event.
//
// Accounts protected by a phone/hardware challenge or enforced SSO cannot be
// signed in unattended; those deployments need a profile seeded out of band.
const googleBotEmail = process.env.GOOGLE_BOT_EMAIL;
const googleBotPassword = process.env.GOOGLE_BOT_PASSWORD;

// Hard cap on one call, so a meeting nobody ended can't hold a browser, an audio
// daemon and a metered WebSocket open indefinitely. Junk or non-positive falls
// back to the default rather than disabling the cap.
const rawMeetingTimeout = parseInt(process.env.MEETING_TIMEOUT_MINUTES ?? '', 10);
const meetingTimeoutMinutes =
  Number.isFinite(rawMeetingTimeout) && rawMeetingTimeout > 0 ? rawMeetingTimeout : 60;

// How long to wait in the waiting room for a host to click "Admit". Generous by
// default: a guest often waits out the host's own join.
const rawAdmissionTimeout = parseInt(process.env.MEETING_ADMISSION_TIMEOUT_SECONDS ?? '', 10);
const meetingAdmissionTimeoutMs =
  (Number.isFinite(rawAdmissionTimeout) && rawAdmissionTimeout > 0 ? rawAdmissionTimeout : 300) * 1000;

// Parsed defensively: `parseInt` yields NaN for junk, and a zero/negative window
// would make the context indicator divide by nothing, so both collapse to null
// (= fall through to the bundled snapshot).
const rawContextWindowTokens = parseInt(process.env.CONTEXT_WINDOW_TOKENS || '', 10);
const contextWindowTokensOverride =
  Number.isFinite(rawContextWindowTokens) && rawContextWindowTokens > 0 ? rawContextWindowTokens : null;

// Opt-in: null unless the operator names a registry URL, so the runtime makes no
// outbound call of its own by default. Enablement derives from whether a value is
// set, matching `nexusMcpUrl` and `otelEndpoint` — there is no separate boolean.
// Whitespace collapses to null so a blank line in a .env file reads as "off"
// rather than as an unreachable URL that would warn on every boot.
const modelsDevUrlOverride = (process.env.MODELS_DEV_URL ?? '').trim() || null;

// Compaction threshold: 0 explicitly disables auto-compaction (null); 1–100 is
// a valid percent; anything else falls back to the default.
const rawCompactionThreshold = parseInt(process.env.COMPACTION_THRESHOLD_PERCENT ?? '', 10);
const compactionThresholdPercent: number | null =
  rawCompactionThreshold === 0
    ? null
    : Number.isFinite(rawCompactionThreshold) && rawCompactionThreshold >= 1 && rawCompactionThreshold <= 100
      ? rawCompactionThreshold
      : COMPACTION_THRESHOLD_PERCENT;

// Tail size: 0 is legal (compact everything; the rebuilt context is just the
// summary pair plus the next user message); junk/negative falls back.
const rawCompactionTail = parseInt(process.env.COMPACTION_TAIL_MESSAGES ?? '', 10);
const compactionTailMessages =
  Number.isFinite(rawCompactionTail) && rawCompactionTail >= 0 ? rawCompactionTail : COMPACTION_TAIL_MESSAGES;

// Same defensive shape as CONTEXT_WINDOW_TOKENS above: junk parses to NaN and
// a non-positive TTL would expire everything on the next sweep, so both fall
// back to the 168 h default.
function resolveAttachmentTtlHours(): number {
  const raw = Number.parseFloat(process.env.ATTACHMENT_TTL_HOURS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : ATTACHMENT_CONTENT_TTL_HOURS;
}

// Optional pre-execution risk evaluation for mutation-capable and otherwise
// sensitive tools. Keep the default off so existing deployments retain their
// current latency and behavior until an operator opts in. `observe` runs the
// classifier and records its verdict without changing execution; `enforce`
// blocks rejected calls and fails closed when the classifier is unavailable.
export type ToolRiskGateMode = 'off' | 'observe' | 'enforce';
const TOOL_RISK_GATE_MODES: ToolRiskGateMode[] = ['off', 'observe', 'enforce'];
const rawToolRiskGateMode = (process.env.TOOL_RISK_GATE_MODE ?? 'off').trim().toLowerCase();
const isValidToolRiskGateMode = (TOOL_RISK_GATE_MODES as string[]).includes(rawToolRiskGateMode);
const toolRiskGateMode = isValidToolRiskGateMode
  ? (rawToolRiskGateMode as ToolRiskGateMode)
  : 'off';
const invalidToolRiskGateMode = isValidToolRiskGateMode ? null : rawToolRiskGateMode;

// Prefer Claude credentials even when an OpenAI key is also available.
export const CODING_AGENTS = ['claude-code', 'codex'] as const;
export type CodingAgentName = (typeof CODING_AGENTS)[number];
const hasClaudeCredentials = hasClaudeCodeCredentials(process.env);
const hasCodexCredentials = Boolean(openaiApiKey) || hasBedrockCredentials(process.env);
const availableCodingAgents: CodingAgentName[] = [
  ...(hasClaudeCredentials ? ['claude-code' as const] : []),
  ...(hasCodexCredentials ? ['codex' as const] : []),
];
const defaultCodingAgent: CodingAgentName = hasClaudeCredentials || !hasCodexCredentials
  ? 'claude-code'
  : 'codex';
const rawCodingAgent = process.env.CODING_AGENT?.trim().toLowerCase();
const isValidCodingAgent = !rawCodingAgent || (CODING_AGENTS as readonly string[]).includes(rawCodingAgent);
const codingAgent: CodingAgentName = isValidCodingAgent && rawCodingAgent
  ? rawCodingAgent as CodingAgentName
  : defaultCodingAgent;
if (!isValidCodingAgent) {
  logger.warn(
    { configuredAgent: rawCodingAgent, effectiveAgent: codingAgent },
    '[Startup] invalid CODING_AGENT; using the default',
  );
}

/** Same shape, for the saved copies of oversized tool results. */
function resolveToolOutputTtlHours(): number {
  const raw = Number.parseFloat(process.env.TOOL_OUTPUT_TTL_HOURS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : TOOL_OUTPUT_TTL_HOURS;
}

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  // Loopback by default, so only this machine connects. The container image
  // sets `PRISM_HOST=0.0.0.0`, which is what a published port needs.
  host: process.env.PRISM_HOST?.trim() || '127.0.0.1',
  // Dev convenience default; production sets DATABASE_URL=file:/data/agent.db
  // via start.sh so the container's mounted /data volume is used.
  databaseUrl: process.env.DATABASE_URL ?? 'file:./agent.db',
  bedrockModelId,
  bedrockClassificationModelId,
  bedrockEmbeddingModelId,
  awsRegion,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsSessionToken: process.env.AWS_SESSION_TOKEN, // Optional, only needed for temporary credentials

  // LLM provider selection. `bedrock` (default), `azure`, `bedrock-mantle`,
  // `openai`, or `anthropic`. See the neutral `chatModelId`/
  // `classificationModelId`/`embeddingModelId` below, which the rest of the
  // runtime reads instead of the vendor-specific fields.
  llmProvider,

  // Embedding provider selection (EMBEDDING_PROVIDER): `bedrock`,
  // `azure-openai`, `openai`, `openrouter`, or `none`. Its own feature
  // (`lib/embedding-providers/`), decoupled from `llmProvider`; unset derives
  // the chat vendor's historical default (see EMBEDDING_PROVIDER_DEFAULTS).
  embeddingProvider,
  // The unrecognized non-empty EMBEDDING_PROVIDER value, kept for the startup
  // warning; null when the value was valid or unset.
  invalidEmbeddingProvider,

  // Azure — Claude via Microsoft Foundry (used when LLM_PROVIDER=azure).
  // Chat/classification speak the Anthropic Messages API at
  // `azureChatEndpoint`; embeddings go to Azure OpenAI (text-embedding-3
  // deployment) on the same resource. Model IDs are Foundry *deployment
  // names*. `azureApiKey` is sent as the `x-api-key` header; it may be a
  // `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire
  // (same mechanism as AWS_BEARER_TOKEN_BEDROCK).
  azureResourceName,
  // Foundry without the gateway, which is the question `isAzureConfigured`
  // asks. Never the chat client's endpoint — that is `azureChatEndpoint`.
  azureDirectEndpoint,
  // The endpoint the Azure chat client uses — override, else gateway mount, else
  // the resource's own host.
  azureChatEndpoint,
  azureApiKey: process.env.AZURE_API_KEY,
  azureApiVersion: process.env.AZURE_API_VERSION, // embeddings only; undefined → SDK default ('preview')
  azureModelId,
  azureClassificationModelId,
  azureEmbeddingModelId,
  nexusAzureBaseUrl,
  nexusAzureOpenAiBaseUrl,

  // Bedrock Mantle — AWS's second inference endpoint (used when
  // LLM_PROVIDER=bedrock-mantle). Chat/classification speak the Anthropic
  // Messages API at `bedrockMantleChatEndpoint`; there is no embedding surface, so
  // embeddings stay on Titan over bedrock-runtime (`bedrockEmbeddingModelId`
  // routing, `nexusLlmBaseUrl` when proxied). Model IDs are *bare* Bedrock IDs
  // — mantle has no cross-region inference profiles. `bedrockApiKey` is the
  // same AWS_BEARER_TOKEN_BEDROCK the native Bedrock path uses, sent here as
  // the `x-api-key` header; required for direct mode (there is no SigV4 path).
  bedrockApiKey,
  // Mantle without the gateway, for `isBedrockMantleConfigured`. Never the chat
  // client's endpoint — that is `bedrockMantleChatEndpoint`.
  bedrockMantleDirectEndpoint,
  // The endpoint the mantle chat client uses — override, else gateway mount,
  // else the region's own host.
  bedrockMantleChatEndpoint,
  bedrockMantleModelId,
  bedrockMantleClassificationModelId,
  bedrockMantleEmbeddingModelId,
  nexusBedrockMantleBaseUrl,

  // OpenAI (used when LLM_PROVIDER=openai). Chat/classification/embeddings all
  // speak the OpenAI API on one surface, at `openaiEndpoint`: OPENAI_BASE_URL if
  // set, else the Lens Agents `…/llm/openai/v1` mount when NEXUS_API_URL is set,
  // else api.openai.com. The key is `openaiApiKey` below (shared with voice
  // meetings); on the gateway no local key is needed.
  openaiModelId,
  openaiClassificationModelId,
  openaiEmbeddingModelId,
  openaiEndpoint,
  nexusOpenAiBaseUrl,

  // OpenRouter (used when LLM_PROVIDER=openrouter). Same OpenAI surface, a
  // different vendor behind it, at `openrouterEndpoint`: OPENROUTER_BASE_URL if
  // set, else the Lens Agents `…/llm/openrouter/openai/v1` mount when
  // NEXUS_API_URL is set, else openrouter.ai. Direct it needs
  // `openrouterApiKey`; on the gateway that key is held for you. Model ids are
  // `vendor/model`.
  openrouterModelId,
  openrouterClassificationModelId,
  openrouterEmbeddingModelId,
  openrouterEndpoint,
  openrouterApiKey,
  nexusOpenRouterBaseUrl,

  // Anthropic (used when LLM_PROVIDER=anthropic). Chat/classification speak
  // the Anthropic Messages API direct to api.anthropic.com (or
  // `anthropicBaseUrl`) — the one vendor with no gateway mount, so
  // `anthropicApiKey` is always required. Anthropic serves no embedding
  // models; memory embeddings come from the embedding provider.
  anthropicApiKey,
  anthropicModelId,
  anthropicClassificationModelId,
  anthropicBaseUrl,

  // AGENT_ID is optional — when unset, `resolveOrBootstrapSingleAgent`
  // either picks up the existing row via findFirst() or creates a fresh
  // one with a generated UUID.
  agentId: process.env.AGENT_ID,

  // First-boot bootstrap defaults. When the SQLite DB is empty (fresh
  // container, or operator wiped /data), the runtime auto-creates an
  // `AgentWorkspace` row using these. Subsequent boots find the row via
  // `findFirst()` and ignore these entirely.
  // OWNER_USER_ID's default is the "local-owner" sentinel: per-message
  // Slack mappings overlay the real `lensUserId` once the user links.
  ownerUserId: process.env.OWNER_USER_ID || '00000000-0000-0000-0000-000000000001',
  agentName: process.env.AGENT_NAME || 'Prism',
  teamName: process.env.TEAM_NAME || 'Local',

  // Per-agent model overrides seeded onto a freshly-bootstrapped agent, read
  // from the shared `~/.prism/settings.json` (`modelId`, `heartbeatModelId`,
  // `cronModelId`). Empty fields leave the column null → the agent resolves to
  // `chatModelId` at invoke time. Read once at startup, same as the rest of
  // config; only consulted by `createAgent`, so a later edit needs a restart.
  agentDefaults: readAgentModelDefaults(),

  nexusApiUrl,

  // Slack — bot token + optional app-id safety check.
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackExpectedAppId: process.env.SLACK_EXPECTED_APP_ID,

  // External MCP server URL — injected directly as NEXUS_MCP_URL by the Lens
  // Agents sandbox (project-scoped /projects/:id/mcp; the MITM proxy injects the
  // Authorization header for that path). Already a complete URL — do NOT append
  // /mcp. null when unset so call sites can skip the external server entirely.
  nexusMcpUrl: process.env.NEXUS_MCP_URL ?? null,

  // Langfuse observability (optional — disabled when keys not set)
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || 'http://localhost:3100',

  // Lens Agents LLM proxy base URL for native Bedrock (see the derivation
  // above). Also carries mantle's embedding leg, since Titan is
  // bedrock-runtime-only.
  nexusLlmBaseUrl,
  // The selected vendor's gateway chat mount — 'is a gateway mount configured
  // for chat?' in one field, so callers don't re-derive the per-vendor branch.
  // An override may send chat elsewhere; `chatRouting` is where it goes.
  nexusChatBaseUrl,
  // Where the selected vendor's chat requests go, and which of override, gateway
  // mount or vendor host named that endpoint. For the startup log.
  chatRouting: isGatewayEndpoint(chatEndpoint.endpoint) ? 'nexus' : 'direct',
  chatEndpointSource,
  chatEndpointForLog: endpointForLog(chatEndpoint.endpoint),

  // OpenTelemetry (optional — disabled when not set)
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  // Optional API key sent as the `x-api-key` header (third-party collector auth)
  otelApiKey: process.env.OTEL_EXPORTER_OTLP_API_KEY || '',
  // Identifies the deployment for OTel resource routing (production | staging | development)
  deploymentEnvironment: process.env.DEPLOYMENT_ENVIRONMENT || 'development',
  // Build identifier emitted as the OTel `service.version` resource attribute.
  // Baked into published images at build time via the `SERVICE_VERSION` Docker
  // ARG/ENV — release-production.yml passes the release tag (e.g.
  // v2026.6.18060952); release-canary.yml passes the build commit SHA. Empty
  // when unset, in which case `service.version` is omitted from the resource
  // (rather than reported as a misleading literal default like `unknown`).
  serviceVersion: process.env.SERVICE_VERSION || '',

  // The runtime's own version, as the updater compares it: the release tag
  // baked into a SEA binary at build time (PRISM_VERSION, an esbuild define —
  // see scripts/build-sea.mjs), else the image's SERVICE_VERSION, else ''.
  // Only a SEA binary with a release-shaped version ever updates itself, so
  // the container/dev values are informational.
  appVersion: sea.isSea()
    ? process.env.PRISM_VERSION || ''
    : process.env.SERVICE_VERSION || '',

  // DISABLE_UPDATER=1 (or =true) turns off update checks, autoupdate, and the
  // manual update command. The updater is already off wherever the install
  // isn't a released SEA binary (containers, dev runs), so this is the kill
  // switch for standalone installs.
  disableUpdater: ['1', 'true'].includes((process.env.DISABLE_UPDATER || '').trim().toLowerCase()),

  // Goals — autonomous multi-turn objectives. `goalMaxTurns` overrides the
  // GOAL_MAX_TURNS hard cap. `goalDefaultTokenBudget` is the per-goal token
  // budget applied when the caller doesn't specify one — null means unbounded
  // (only the turn/stall caps bound the goal).
  goalMaxTurns: process.env.GOAL_MAX_TURNS ? parseInt(process.env.GOAL_MAX_TURNS, 10) : GOAL_MAX_TURNS,
  goalDefaultTokenBudget: process.env.GOAL_DEFAULT_TOKEN_BUDGET
    ? parseInt(process.env.GOAL_DEFAULT_TOKEN_BUDGET, 10)
    : null,

  // How long attachment content (the media file) is kept before the hourly
  // sweep deletes it. The metadata row survives, so conversation history keeps
  // its stubs. ATTACHMENT_TTL_HOURS overrides the 168 h (7 day) default; a
  // non-positive or unparseable value falls back to the default rather than
  // expiring everything (negative) or throwing hourly (NaN → Invalid Date).
  attachmentContentTtlMs: resolveAttachmentTtlHours() * 60 * 60 * 1000,
  toolOutputTtlMs: resolveToolOutputTtlHours() * 60 * 60 * 1000,

  // Provider-neutral model IDs (see the `modelIds` lookup above). The runtime
  // (invoke, classification gate, embeddings, per-agent model fallback) reads
  // these so it never has to know which vendor is active. For Azure these are
  // deployment names; on bedrock-mantle they are bare Bedrock IDs. The
  // embedding id follows `embeddingProvider`, not the chat vendor; '' means
  // embeddings are disabled (embedding.service skips the SDK call entirely).
  chatModelId: modelIds.chat,
  classificationModelId: modelIds.classification,
  embeddingModelId,

  // Fast-model pre-execution policy gate for sensitive tool calls. Invalid
  // values resolve to off; index.ts emits a startup warning using the companion
  // field so a typo never silently enables enforcement or changes behavior.
  toolRiskGateMode,
  invalidToolRiskGateMode,

  codingAgent,
  availableCodingAgents,

  // Overrides the input-context window used by the context-window indicator.
  // Normally derived from the model ID via the models.dev catalog
  // (`lib/model-catalog.ts`); this is the escape hatch for a model neither the
  // bundled floor nor the boot-time refresh can know — most often a custom Azure Foundry deployment name, which is
  // user-chosen and so appears in no registry. Provider-neutral on purpose: the
  // window is a property of the model, not the vendor. A non-numeric or
  // non-positive value is ignored rather than fatal, so a typo degrades to the
  // snapshot instead of breaking the indicator.
  contextWindowTokens: contextWindowTokensOverride,

  // Registry to refresh the model-window catalog from, once at startup, so a model
  // released since the last build still gets a real context window. **Opt-in**:
  // null unless set, and the bundled catalog answers every lookup either way, so
  // leaving it unset costs nothing but freshness. Set it to
  // `https://models.dev/api.json` to enable. Same variable
  // `src/scripts/generate-model-limits.ts` reads, same meaning.
  modelsDevUrl: modelsDevUrlOverride,

  // Auto-compaction trigger, as a percent of the model's context window. null
  // means disabled (COMPACTION_THRESHOLD_PERCENT=0); otherwise 1–100, default
  // COMPACTION_THRESHOLD_PERCENT (90).
  compactionThresholdPercent,

  // Newest messages excluded from compaction and kept verbatim in the context.
  // COMPACTION_TAIL_MESSAGES, default COMPACTION_TAIL_MESSAGES (6); 0 is legal.
  compactionTailMessages,

  // Live voice meetings (see the derivations above). The meeting tools are only
  // registered when `openaiApiKey` is set AND the container has the browser and
  // audio toolchain. The name shown to participants is the Google account's own, so
  // there is no display-name setting: it is a per-join argument for platforms that
  // admit named guests, defaulting to the agent's name.
  openaiApiKey,
  openaiRealtimeModel,
  // OPENAI_REALTIME_URL, unset in every deployment: the Realtime WebSocket host,
  // for a test that runs a local voice model instead of api.openai.com.
  openaiRealtimeUrl,
  openaiRealtimeVoice,
  // OPENAI_REALTIME_REASONING_EFFORT, default 'high' (the API's own default is
  // 'low'); '' sends no setting at all and leaves the choice to the API.
  openaiRealtimeReasoningEffort,
  openaiTranscriptionModel,
  noiseReduction,
  // MEETING_TRANSCRIPT_LOGGING, default 'off': whether a meeting's speech may appear
  // in the runtime's logs ('off' | 'full').
  meetingTranscriptLogging,
  googleBotEmail,
  googleBotPassword,
  meetingTimeoutMinutes,
  meetingAdmissionTimeoutMs,
};
