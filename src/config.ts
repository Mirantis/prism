import path from 'path';
import dotenv from 'dotenv';

const dotenvPath = path.resolve(__dirname, '../.env');
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

const nexusUrl = process.env.NEXUS_URL || 'http://localhost:3002';

// Single-agent mode: when the runtime is scoped to exactly one agent (the
// endgame per-sandbox shape), a handful of multi-tenant behaviors collapse:
// no backend dependency at startup, WS access gated by AGENT_ID match,
// Slack config sourced from env instead of backend.
const singleAgentMode =
  process.env.SINGLE_AGENT_MODE === '1' ||
  process.env.SINGLE_AGENT_MODE?.toLowerCase() === 'true';

// In single-agent mode the container owns its DB file; the spawner just
// mounts /data. Default DATABASE_URL so the caller doesn't have to know
// the internal path. Multi-tenant mode requires an explicit URL.
const databaseUrl = process.env.DATABASE_URL ?? (singleAgentMode ? 'file:/data/agent.db' : undefined);

// Internal API secret — multi-tenant uses this to gate the
// `/agents/*` management API that the backend calls into. Single-
// agent has no backend, so it's unused there (no auto-generation).
const internalApiSecret = process.env.INTERNAL_API_SECRET;

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  databaseUrl,
  internalApiSecret,
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-4-7',
  bedrockClassificationModelId: process.env.BEDROCK_CLASSIFICATION_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  bedrockEmbeddingModelId: process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0',
  awsRegion: process.env.AWS_REGION || 'us-east-1',
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsSessionToken: process.env.AWS_SESSION_TOKEN, // Optional, only needed for temporary credentials

  // Backend internal REST API (unused when singleAgentMode is on)
  backendUrl: process.env.BACKEND_URL || 'http://localhost:3001',

  // Single-agent mode
  singleAgentMode,
  agentId: process.env.AGENT_ID,

  // First-boot bootstrap defaults for single-agent mode. When the SQLite DB
  // is empty (fresh container, or operator wiped /data), the runtime
  // auto-creates an `AgentWorkspace` row using these. Subsequent boots find
  // the row via `findFirst()` and ignore these entirely.
  // OWNER_USER_ID's default is the "local-owner" sentinel: per-message
  // Slack mappings overlay the real `lensUserId` once the user links.
  ownerUserId: process.env.OWNER_USER_ID || '00000000-0000-0000-0000-000000000001',
  agentName: process.env.AGENT_NAME || 'Prism',
  teamName: process.env.TEAM_NAME || 'Local',

  nexusUrl,

  // Slack — bot token + optional app-id safety check (for single-agent mode).
  // In multi-tenant mode these come from the backend SlackConnection table.
  slackBotToken: process.env.SLACK_BOT_TOKEN,
  slackExpectedAppId: process.env.SLACK_EXPECTED_APP_ID,

  // External MCP server URL — Nexus hosts kubectl / GitHub / AWS
  // tools as a real cross-process MCP server.
  nexusMcpUrl: `${nexusUrl}/mcp`,

  // Langfuse observability (optional — disabled when keys not set)
  langfuseSecretKey: process.env.LANGFUSE_SECRET_KEY,
  langfusePublicKey: process.env.LANGFUSE_PUBLIC_KEY,
  langfuseBaseUrl: process.env.LANGFUSE_BASE_URL || 'http://localhost:3100',

  // Nexus LLM proxy base URL (auto-resolve project route: /v1/llm/bedrock/{region})
  nexusLlmBaseUrl: `${nexusUrl}/v1/llm/bedrock/${process.env.AWS_REGION || 'us-east-1'}`,

  // OpenTelemetry (optional — disabled when not set)
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  // Optional API key sent as the `x-api-key` header (third-party collector auth)
  otelApiKey: process.env.OTEL_EXPORTER_OTLP_API_KEY || '',
  // Identifies the deployment for OTel resource routing (production | staging | development)
  deploymentEnvironment: process.env.DEPLOYMENT_ENVIRONMENT || 'development',
};

