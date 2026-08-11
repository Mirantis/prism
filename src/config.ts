import path from 'path';
import sea from 'node:sea';
import dotenv from 'dotenv';
import { GOAL_MAX_TURNS } from './constants';
import { readAgentModelDefaults } from './lib/prism-settings';

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
// AGENT_ID per container). Anything unrecognized falls back to `bedrock` so an
// unset/typo'd value never silently breaks a Bedrock deployment.
const rawLlmProvider = (process.env.LLM_PROVIDER || 'bedrock').toLowerCase();
const llmProvider: 'bedrock' | 'azure' | 'bedrock-mantle' =
  rawLlmProvider === 'azure'
    ? 'azure'
    : rawLlmProvider === 'bedrock-mantle'
      ? 'bedrock-mantle'
      : 'bedrock';

// Nexus LLM proxy base URL for native Bedrock (bedrock-runtime). Mirrors the
// Nexus route mounts:
//   /projects/{projectId}/llm/bedrock/{region}  (explicit project — PROJECT_ID set)
//   /llm/bedrock/{region}                        (auto-resolve project — PROJECT_ID unset)
// null when NEXUS_API_URL itself is unset (callers route direct to Bedrock
// instead of going through Nexus). On `bedrock-mantle` this still carries the
// *embedding* leg (Titan lives on bedrock-runtime, not on mantle) even though
// chat rides `nexusBedrockMantleBaseUrl`.
const nexusLlmBaseUrl = nexusApiUrl
  ? (projectId
      ? `${nexusApiUrl}/projects/${projectId}/llm/bedrock/${awsRegion}`
      : `${nexusApiUrl}/llm/bedrock/${awsRegion}`)
  : null;

// Nexus LLM proxy base URLs for Azure. Mirrors the Bedrock route mount above
// (`nexusLlmBaseUrl`), swapping the vendor segment. Nexus exposes the two
// Foundry surfaces separately (`…/llm/azure/anthropic/{path}` → the resource's
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

// Nexus LLM proxy base URL for bedrock-mantle's Anthropic surface, mounted as
// `…/llm/bedrock-mantle/anthropic/{region}/{path}` (nexus-monorepo#414) and
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

// The selected vendor's Nexus *chat* mount, resolved once so callers that only
// need "is chat routed through Nexus?" (the startup log, startup telemetry)
// don't each re-derive the per-vendor branch. null → chat goes direct.
const nexusChatBaseUrl =
  llmProvider === 'azure'
    ? nexusAzureBaseUrl
    : llmProvider === 'bedrock-mantle'
      ? nexusBedrockMantleBaseUrl
      : nexusLlmBaseUrl;

// Foundry Anthropic chat endpoint for Azure (Claude via Microsoft Foundry).
// Explicit override wins; else derived from the resource name. Must end at
// `/anthropic/v1` — the anthropic SDK appends `/messages`.
const azureResourceName = process.env.AZURE_RESOURCE_NAME;
const azureFoundryBaseUrl =
  process.env.AZURE_FOUNDRY_BASE_URL ||
  (azureResourceName ? `https://${azureResourceName}.services.ai.azure.com/anthropic/v1` : undefined);

// The Bedrock API key. The @ai-sdk/amazon-bedrock SDK reads this straight from
// process.env for the native Bedrock path, but mantle's Anthropic surface needs
// it explicitly (sent as `x-api-key`), so it comes through config too. May be a
// `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire.
const bedrockApiKey = process.env.AWS_BEARER_TOKEN_BEDROCK;

// Direct bedrock-mantle chat endpoint. Must end at `/anthropic/v1` — the
// anthropic SDK appends `/messages`. The override mirrors AZURE_FOUNDRY_BASE_URL
// and, like it, applies to direct mode only (Nexus routing has its own mount).
const bedrockMantleBaseUrl =
  process.env.BEDROCK_MANTLE_BASE_URL || `https://bedrock-mantle.${awsRegion}.api.aws/anthropic/v1`;

// Resolved once so the vendor-specific fields and the provider-neutral
// `chatModelId`/`classificationModelId`/`embeddingModelId` share one source.
const bedrockModelId = process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-5';
const bedrockClassificationModelId =
  process.env.BEDROCK_CLASSIFICATION_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0';
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

// Provider-neutral model IDs, resolved once. The runtime (invoke, the
// classification gate, embeddings, the per-agent model fallback) reads these so
// it never has to know which vendor is active.
const modelIds = {
  bedrock: {
    chat: bedrockModelId,
    classification: bedrockClassificationModelId,
    embedding: bedrockEmbeddingModelId,
  },
  azure: {
    chat: azureModelId,
    classification: azureClassificationModelId,
    embedding: azureEmbeddingModelId,
  },
  'bedrock-mantle': {
    chat: bedrockMantleModelId,
    classification: bedrockMantleClassificationModelId,
    embedding: bedrockMantleEmbeddingModelId,
  },
}[llmProvider];

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

// Tool names withheld from every invocation, comma-separated. Exists so an
// operator can narrow the tool surface without a rebuild — the motivating case
// is a benchmark run that must measure this agent's own loop, where leaving
// `claude_code` enabled would let a nested agent do the work and make the score
// unattributable. Names are matched exactly against the assembled tool map, so
// an unknown name is inert rather than an error.
const disabledTools = (process.env.PRISM_DISABLED_TOOLS ?? '')
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean);

// Reasoning effort for the chat/invoke path, passed through to the Anthropic
// Messages surface as `providerOptions.anthropic.effort`. Unset = the model's
// own default (`high`). Validated here so a typo fails loudly at boot instead
// of 400ing on the first turn; note the vendors that don't accept it ignore the
// fragment rather than rejecting it.
const rawReasoningEffort = (process.env.PRISM_REASONING_EFFORT ?? '').trim().toLowerCase();
const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = (typeof REASONING_EFFORTS)[number];
if (rawReasoningEffort && !(REASONING_EFFORTS as readonly string[]).includes(rawReasoningEffort)) {
  throw new Error(
    `Invalid PRISM_REASONING_EFFORT "${rawReasoningEffort}" — expected one of ${REASONING_EFFORTS.join(', ')}`,
  );
}
const reasoningEffort = (rawReasoningEffort || null) as ReasoningEffort | null;

// Thinking mode for the chat/invoke path. Unset leaves the field off the
// request, which is *not* the same as "off" on every model: Fable 5 thinks
// always, Opus 5 thinks by default, but Opus 4.8/4.7 and Sonnet 4.6 run with no
// thinking at all unless `adaptive` is sent explicitly. Set this to `adaptive`
// on those models to get their intended agentic behavior.
const rawThinking = (process.env.PRISM_THINKING ?? '').trim().toLowerCase();
const THINKING_MODES = ['adaptive', 'disabled'] as const;
export type ThinkingMode = (typeof THINKING_MODES)[number];
if (rawThinking && !(THINKING_MODES as readonly string[]).includes(rawThinking)) {
  throw new Error(
    `Invalid PRISM_THINKING "${rawThinking}" — expected one of ${THINKING_MODES.join(', ')}`,
  );
}
const thinking = (rawThinking || null) as ThinkingMode | null;

// Suppress everything the agent starts on its own: heartbeat timers, cron
// registration, goal resumption, session resets, the Slack throttle queue, and
// the periodic attachment sweep. Request-driven turns still work.
//
// Exists for runs that must measure exactly one turn — a benchmark trial, where
// a heartbeat firing mid-task would edit the tree under the grader and make the
// result unattributable. This is not a lighter boot: it changes what the agent
// is, so leave it off for any normal deployment.
const disableAutonomy = (process.env.PRISM_DISABLE_AUTONOMY ?? '').trim().toLowerCase() === 'true';

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
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

  // LLM provider selection. `bedrock` (default), `azure`, or `bedrock-mantle`.
  // See the neutral `chatModelId`/`classificationModelId`/`embeddingModelId`
  // below, which the rest of the runtime reads instead of the vendor-specific
  // fields.
  llmProvider,

  // Azure — Claude via Microsoft Foundry (used when LLM_PROVIDER=azure).
  // Chat/classification speak the Anthropic Messages API at
  // `azureFoundryBaseUrl`; embeddings go to Azure OpenAI (text-embedding-3
  // deployment) on the same resource. Model IDs are Foundry *deployment
  // names*. `azureApiKey` is sent as the `x-api-key` header; it may be a
  // `__nexus_cred:<uuid>__` sentinel the MITM proxy rewrites on the wire
  // (same mechanism as AWS_BEARER_TOKEN_BEDROCK).
  azureResourceName,
  azureFoundryBaseUrl,
  azureApiKey: process.env.AZURE_API_KEY,
  azureApiVersion: process.env.AZURE_API_VERSION, // embeddings only; undefined → SDK default ('preview')
  azureModelId,
  azureClassificationModelId,
  azureEmbeddingModelId,
  nexusAzureBaseUrl,
  nexusAzureOpenAiBaseUrl,

  // Bedrock Mantle — AWS's second inference endpoint (used when
  // LLM_PROVIDER=bedrock-mantle). Chat/classification speak the Anthropic
  // Messages API at `bedrockMantleBaseUrl`; there is no embedding surface, so
  // embeddings stay on Titan over bedrock-runtime (`bedrockEmbeddingModelId`
  // routing, `nexusLlmBaseUrl` when proxied). Model IDs are *bare* Bedrock IDs
  // — mantle has no cross-region inference profiles. `bedrockApiKey` is the
  // same AWS_BEARER_TOKEN_BEDROCK the native Bedrock path uses, sent here as
  // the `x-api-key` header; required for direct mode (there is no SigV4 path).
  bedrockApiKey,
  bedrockMantleBaseUrl,
  bedrockMantleModelId,
  bedrockMantleClassificationModelId,
  bedrockMantleEmbeddingModelId,
  nexusBedrockMantleBaseUrl,

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

  // External MCP server URL — injected directly as NEXUS_MCP_URL by the Nexus
  // sandbox (project-scoped /projects/:id/mcp; the MITM proxy injects the
  // Authorization header for that path). Already a complete URL — do NOT append
  // /mcp. null when unset so call sites can skip Nexus entirely.
  nexusMcpUrl: process.env.NEXUS_MCP_URL ?? null,

  // Langfuse observability (optional — disabled when keys not set)
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || 'http://localhost:3100',

  // Nexus LLM proxy base URL for native Bedrock (see the derivation above).
  // Also carries mantle's embedding leg, since Titan is bedrock-runtime-only.
  nexusLlmBaseUrl,
  // The selected vendor's Nexus chat mount — 'routed through Nexus?' in one
  // field, so callers don't re-derive the per-vendor branch.
  nexusChatBaseUrl,

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

  // Goals — autonomous multi-turn objectives. `goalMaxTurns` overrides the
  // GOAL_MAX_TURNS hard cap. `goalDefaultTokenBudget` is the per-goal token
  // budget applied when the caller doesn't specify one — null means unbounded
  // (only the turn/stall caps bound the goal).
  goalMaxTurns: process.env.GOAL_MAX_TURNS ? parseInt(process.env.GOAL_MAX_TURNS, 10) : GOAL_MAX_TURNS,
  goalDefaultTokenBudget: process.env.GOAL_DEFAULT_TOKEN_BUDGET
    ? parseInt(process.env.GOAL_DEFAULT_TOKEN_BUDGET, 10)
    : null,

  // Tool names withheld from every invocation, the reasoning effort and
  // thinking mode passed to the model, and the autonomy kill switch (see the
  // derivations above).
  disabledTools,
  reasoningEffort,
  thinking,
  disableAutonomy,

  // Provider-neutral model IDs (see the `modelIds` lookup above). The runtime
  // (invoke, classification gate, embeddings, per-agent model fallback) reads
  // these so it never has to know which vendor is active. For Azure these are
  // deployment names; on bedrock-mantle they are bare Bedrock IDs.
  chatModelId: modelIds.chat,
  classificationModelId: modelIds.classification,
  embeddingModelId: modelIds.embedding,

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
};
