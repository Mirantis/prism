/**
 * Startup Telemetry
 *
 * Single owner of the `agent started` product event — one census per boot,
 * emitted from `index.ts` once the agent row is resolved and cron tasks are
 * registered. It answers fleet-level product questions the Pino startup logs
 * can't: which LLM vendor/models deployments actually run, whether they route
 * through Nexus, which integrations are wired up, what host Prism runs on, and
 * how much of the feature surface is configured.
 *
 * Only ids, flags, counts and model identifiers — never tokens, URLs, paths or
 * user content. `deployment.environment.name` / `service.version` are already
 * OTel *resource* attributes (see `telemetry.ts`), so they are not repeated as
 * properties; heartbeat interval/status are owned by `heartbeat started`.
 */

import sea from 'node:sea';
import { AgentWorkspace } from '@prisma/client';
import { config } from '../config';
import { logger } from '../logger';
import { trackEvent, isTelemetryEnabled } from './telemetry';
import { skillCatalogService } from '../services/skill-catalog.service';
import { agentWorkspaceService } from '../services/agent-workspace.service';

export async function trackAgentStarted(
  agent: Pick<AgentWorkspace, 'id' | 'userId' | 'webhooksEnabled'>,
  opts: { cronTasks: number },
): Promise<void> {
  // Gathering the census costs a skills-dir scan and a DB round-trip, both
  // pointless when `trackEvent` would no-op anyway (no OTel endpoint) — as in
  // the local dev loop.
  if (!isTelemetryEnabled()) return;

  try {
    // Same routing expression as the `[Startup] LLM provider` log: 'nexus'
    // when the selected vendor's Nexus base URL is set, else 'direct'.
    const nexusBaseUrl =
      config.llmProvider === 'azure' ? config.nexusAzureBaseUrl : config.nexusLlmBaseUrl;
    // No workspaceRoot at boot — this counts the globally installed skills.
    const skills = skillCatalogService.getCatalog();
    const subagents = await agentWorkspaceService.getSubagents(agent.id);

    trackEvent('agent started', agent.userId, {
      'agent.id': agent.id,
      'llm.provider': config.llmProvider,
      'llm.routing': nexusBaseUrl ? 'nexus' : 'direct',
      'llm.chat_model': config.chatModelId,
      'llm.classification_model': config.classificationModelId,
      // Empty when embeddings are disabled (AZURE_EMBEDDING_MODEL_ID='').
      ...(config.embeddingModelId ? { 'llm.embedding_model': config.embeddingModelId } : {}),
      // Meaningless on Azure, where the resource name pins the region.
      ...(config.llmProvider === 'bedrock' ? { 'llm.region': config.awsRegion } : {}),
      'slack.enabled': String(Boolean(config.slackBotToken)),
      'nexus.enabled': String(Boolean(config.nexusApiUrl)),
      'nexus.mcp_enabled': String(Boolean(config.nexusMcpUrl)),
      'langfuse.enabled': String(Boolean(config.langfuseSecretKey && config.langfusePublicKey)),
      // The packaged `prism-server` binary vs a container/source run.
      'runtime.sea': String(sea.isSea()),
      'runtime.node_version': process.version,
      'runtime.platform': process.platform,
      'runtime.arch': process.arch,
      'webhook.receiver_enabled': String(agent.webhooksEnabled),
      'cron.tasks': String(opts.cronTasks),
      'skills.count': String(skills.length),
      'agent.subagents': String(subagents.length),
    });
  } catch (error: unknown) {
    // Best-effort: a census failure must never take down the boot. Log the
    // error object so pino serializes the stack — this is the only diagnostic
    // for a census that silently stops arriving.
    logger.warn({ err: error }, '[Startup] agent-started telemetry failed');
  }
}
