import path from 'path';
import sea from 'node:sea';
import dotenv from 'dotenv';
import { COMPACTION_TAIL_MESSAGES, COMPACTION_THRESHOLD_PERCENT, GOAL_MAX_TURNS } from './constants';
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

// Live voice meetings (OpenAI Realtime API). This is the one model call that does
// NOT ride the Nexus LLM gateway: managed inference serves Bedrock, Azure and
// Bedrock Mantle — the Anthropic Messages and OpenAI Chat Completions surfaces —
// and none of them serves the Realtime WebSocket, so there is no vendor mount to
// route through and the socket goes straight to api.openai.com. Still
// credential-safe in a sandbox: the key may be a `__nexus_cred:<uuid>__` sentinel
// that the egress MITM swaps on the wire, and it is only ever sent as a header.
// Unset disables the meeting tools entirely (they're also gated on the browser and
// audio toolchain being present).
const openaiApiKey = process.env.OPENAI_API_KEY;
// Pinned to a snapshot rather than the `gpt-realtime` alias. The alias silently
// follows OpenAI's current snapshot, and a voice model changing under a live
// deployment shifts turn-taking and prosody with no code change to point at.
const openaiRealtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1';
// `marin` is markedly better for conversation than the API's `alloy` default.
// Overridable because a future model may retire a voice name.
const openaiRealtimeVoice = process.env.OPENAI_REALTIME_VOICE || 'marin';
// Transcriber feeding the addressed gate (billed per audio minute, on for every
// call). `gpt-live-transcribe` streams as the sentence unfolds *and* accepts
// `keywords`, which is what lets the agent's own name be seeded into the decoder
// — the one word the transcript exists to find, and the one a speech model is
// most likely to drop. Only it and `gpt-transcribe` take keywords at all, and
// only it streams. Override at your own risk: a model without `keywords`
// silently ignores the name and the gate goes deaf to whoever it garbles.
const openaiTranscriptionModel =
  process.env.OPENAI_TRANSCRIPTION_MODEL || 'gpt-live-transcribe';

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
  openaiRealtimeVoice,
  openaiTranscriptionModel,
  googleBotEmail,
  googleBotPassword,
  meetingTimeoutMinutes,
  meetingAdmissionTimeoutMs,
};
