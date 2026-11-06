/**
 * Startup Telemetry
 *
 * Single owner of the `agent started` product event — one census per boot,
 * emitted from `index.ts` once the agent row is resolved and cron tasks are
 * registered. It answers fleet-level product questions the Pino startup logs
 * can't: which LLM vendor/models deployments actually run, whether they route
 * through the gateway, which integrations are wired up, what host Prism Agent runs
 * on, and how much of the feature surface is configured.
 *
 * Only ids, flags, counts and model identifiers — never tokens, URLs, paths or
 * user content. `deployment.environment.name` / `service.version` are already
 * OTel *resource* attributes (see `telemetry.ts`), so they are not repeated as
 * properties; heartbeat interval/status are owned by `heartbeat started`.
 */

import sea from 'node:sea';
import { AgentWorkspace } from '@prisma/client';
import { config } from '../config';
import { getExecutionEnvironment } from './execution-environments/get-execution-environment';
import { logger } from '../logger';
import { trackEvent, isTelemetryEnabled, llmRouting } from './telemetry';
import { modelCatalogState } from './model-catalog';
import { skillCatalogService } from '../services/skill-catalog.service';
import { pluginCatalogService } from '../services/plugin-catalog.service';
import { agentWorkspaceService } from '../services/agent-workspace.service';

export async function trackAgentStarted(
  agent: Pick<AgentWorkspace, 'id' | 'userId' | 'webhooksEnabled' | 'lockedIn'>,
  opts: { cronTasks: number },
): Promise<void> {
  // Gathering the census costs a skills-dir scan and a DB round-trip, both
  // pointless when `trackEvent` would no-op anyway (no OTel endpoint) — as in
  // the local dev loop.
  if (!isTelemetryEnabled()) return;

  try {
    // No workspaceRoot at boot — this counts the globally installed skills,
    // which includes any a plugin contributes.
    const skills = await skillCatalogService.getCatalog();
    const plugins = await pluginCatalogService.getPlugins();
    const subagents = await agentWorkspaceService.getSubagents(agent.id);

    trackEvent('agent started', agent.userId, {
      'agent.id': agent.id,
      'llm.provider': config.llmProvider,
      'llm.routing': llmRouting(),
      'llm.chat_model': config.chatModelId,
      'llm.classification_model': config.classificationModelId,
      // Read synchronously — the boot-time models.dev refresh may not have settled
      // yet, and 'pending' (i.e. slower than boot) is itself the useful signal.
      // Deliberately not awaited: the census must never gate on a network call.
      'model_catalog.state': modelCatalogState(),
      // Which vendor embeds memory — its own selection, decoupled from the
      // chat vendor (EMBEDDING_PROVIDER). 'none' only when the selector disabled
      // embeddings; a vendor whose embedding model id is set to '' still
      // reports the vendor, so the disabled signal is the absence of
      // `llm.embedding_model` below, not this value.
      'llm.embedding_provider': config.embeddingProvider,
      // Empty when embeddings are disabled (EMBEDDING_PROVIDER=none, or the
      // active `*_EMBEDDING_MODEL_ID` set to '').
      ...(config.embeddingModelId ? { 'llm.embedding_model': config.embeddingModelId } : {}),
      // Only the AWS endpoints are regional; meaningless on Azure (the
      // resource name pins the region) and on OpenAI/Anthropic (no region at
      // all) — an allowlist, so a new region-less vendor never inherits it.
      ...(config.llmProvider === 'bedrock' || config.llmProvider === 'bedrock-mantle'
        ? { 'llm.region': config.awsRegion }
        : {}),
      'tool_risk_gate.mode': config.toolRiskGateMode,
      'threads.mode': config.threadMode,
      // Which coding agent the coding_agent tools delegate to.
      'coding_agent': config.codingAgent,
      'execution_environment': getExecutionEnvironment().id,
      'slack.enabled': String(Boolean(config.slackBotToken)),
      'teams.enabled': String(
        Boolean(config.teamsAppId && config.teamsAppPassword && config.teamsAppTenantId)
      ),
      'nexus.enabled': String(Boolean(config.nexusApiUrl)),
      'nexus.mcp_enabled': String(Boolean(config.nexusMcpUrl)),
      'langfuse.enabled': String(Boolean(config.langfuseSecretKey && config.langfusePublicKey)),
      // Whether the runtime reports the agent's state on stdout (OSC 7501).
      'program_status.enabled': String(config.programStatusReports),
      // The packaged `prism-server` binary vs a container/source run.
      'runtime.sea': String(sea.isSea()),
      'runtime.node_version': process.version,
      'runtime.platform': process.platform,
      'runtime.arch': process.arch,
      'webhook.receiver_enabled': String(agent.webhooksEnabled),
      'agent.locked_in': String(agent.lockedIn),
      'cron.tasks': String(opts.cronTasks),
      'skills.count': String(skills.length),
      'plugins.count': String(plugins.length),
      'agent.subagents': String(subagents.length),
    });
  } catch (error: unknown) {
    // Best-effort: a census failure must never take down the boot. Log the
    // error object so pino serializes the stack — this is the only diagnostic
    // for a census that silently stops arriving.
    logger.warn({ err: error }, '[Startup] agent-started telemetry failed');
  }
}
