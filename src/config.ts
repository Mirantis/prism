import path from 'path';
import sea from 'node:sea';
import dotenv from 'dotenv';
import { GOAL_MAX_TURNS } from './constants';

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

export const config = {
  port: parseInt(process.env.PORT || '3003', 10),
  // Dev convenience default; production sets DATABASE_URL=file:/data/agent.db
  // via start.sh so the container's mounted /data volume is used.
  databaseUrl: process.env.DATABASE_URL ?? 'file:./agent.db',
  bedrockModelId: process.env.BEDROCK_MODEL_ID || 'us.anthropic.claude-opus-4-7',
  bedrockClassificationModelId: process.env.BEDROCK_CLASSIFICATION_MODEL_ID || 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  bedrockEmbeddingModelId: process.env.BEDROCK_EMBEDDING_MODEL_ID || 'amazon.titan-embed-text-v2:0',
  awsRegion,
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  awsSessionToken: process.env.AWS_SESSION_TOKEN, // Optional, only needed for temporary credentials

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

  // Nexus LLM proxy base URL. Mirrors the Nexus route mounts:
  //   /projects/{projectId}/llm/bedrock/{region}  (explicit project — PROJECT_ID set)
  //   /llm/bedrock/{region}                        (auto-resolve project — PROJECT_ID unset)
  // null when NEXUS_API_URL itself is unset (callers route direct Bedrock
  // instead of going through Nexus).
  nexusLlmBaseUrl: nexusApiUrl
    ? (projectId
        ? `${nexusApiUrl}/projects/${projectId}/llm/bedrock/${awsRegion}`
        : `${nexusApiUrl}/llm/bedrock/${awsRegion}`)
    : null,

  // OpenTelemetry (optional — disabled when not set)
  otelEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || '',
  // Optional API key sent as the `x-api-key` header (third-party collector auth)
  otelApiKey: process.env.OTEL_EXPORTER_OTLP_API_KEY || '',
  // Identifies the deployment for OTel resource routing (production | staging | development)
  deploymentEnvironment: process.env.DEPLOYMENT_ENVIRONMENT || 'development',

  // Goals — autonomous multi-turn objectives. `goalMaxTurns` overrides the
  // GOAL_MAX_TURNS hard cap. `goalDefaultTokenBudget` is the per-goal token
  // budget applied when the caller doesn't specify one — null means unbounded
  // (only the turn/stall caps bound the goal).
  goalMaxTurns: process.env.GOAL_MAX_TURNS ? parseInt(process.env.GOAL_MAX_TURNS, 10) : GOAL_MAX_TURNS,
  goalDefaultTokenBudget: process.env.GOAL_DEFAULT_TOKEN_BUDGET
    ? parseInt(process.env.GOAL_DEFAULT_TOKEN_BUDGET, 10)
    : null,
};
