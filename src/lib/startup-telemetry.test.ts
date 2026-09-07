import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockTrackEvent,
  mockIsTelemetryEnabled,
  mockGetCatalog,
  mockGetSubagents,
  mockConfig,
  mockLogger,
} = vi.hoisted(() => ({
  mockTrackEvent: vi.fn(),
  mockIsTelemetryEnabled: vi.fn(),
  mockGetCatalog: vi.fn(),
  mockGetSubagents: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockConfig: {} as Record<string, unknown>,
}));

vi.mock('./telemetry', () => ({
  trackEvent: mockTrackEvent,
  isTelemetryEnabled: mockIsTelemetryEnabled,
}));
vi.mock('../logger', () => ({ logger: mockLogger }));
vi.mock('../config', () => ({ config: mockConfig }));
vi.mock('../services/skill-catalog.service', () => ({
  skillCatalogService: { getCatalog: mockGetCatalog },
}));
vi.mock('../services/agent-workspace.service', () => ({
  agentWorkspaceService: { getSubagents: mockGetSubagents },
}));

import { trackAgentStarted } from './startup-telemetry';

const BEDROCK_CONFIG = {
  llmProvider: 'bedrock',
  chatModelId: 'us.anthropic.claude-opus-4-8',
  classificationModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  toolRiskGateMode: 'off',
  codingAgent: 'claude-code',
  embeddingProvider: 'bedrock',
  embeddingModelId: 'amazon.titan-embed-text-v2:0',
  awsRegion: 'us-east-1',
  nexusLlmBaseUrl: 'https://gateway.test/llm/bedrock/us-east-1',
  nexusAzureBaseUrl: null,
  nexusBedrockMantleBaseUrl: null,
  // config resolves this to the selected vendor's chat mount; telemetry only
  // reads this one field.
  nexusChatBaseUrl: 'https://gateway.test/llm/bedrock/us-east-1',
  nexusApiUrl: 'https://gateway.test',
  nexusMcpUrl: 'https://gateway.test/projects/p1/mcp',
  slackBotToken: 'xoxb-test',
  langfuseSecretKey: undefined,
  langfusePublicKey: undefined,
};

const AGENT = { id: 'agent-1', userId: 'user-1', webhooksEnabled: false };

function setConfig(overrides: Record<string, unknown>): void {
  for (const key of Object.keys(mockConfig)) delete mockConfig[key];
  Object.assign(mockConfig, BEDROCK_CONFIG, overrides);
}

/** Props of the single emitted `agent started` event. */
function emittedProps(): Record<string, string> {
  expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  return mockTrackEvent.mock.calls[0][2] as Record<string, string>;
}

describe('trackAgentStarted', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setConfig({});
    mockIsTelemetryEnabled.mockReturnValue(true);
    mockGetCatalog.mockReturnValue([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    mockGetSubagents.mockResolvedValue([{ id: 'sub-1' }]);
  });

  it('emits one `agent started` census for a Bedrock + gateway deployment', async () => {
    await trackAgentStarted({ ...AGENT, webhooksEnabled: true }, { cronTasks: 3 });

    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
    const [event, userId, props] = mockTrackEvent.mock.calls[0];
    expect(event).toBe('agent started');
    expect(userId).toBe('user-1');
    expect(props).toMatchObject({
      'agent.id': 'agent-1',
      'llm.provider': 'bedrock',
      'llm.routing': 'nexus',
      'llm.chat_model': 'us.anthropic.claude-opus-4-8',
      'llm.classification_model': 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      'tool_risk_gate.mode': 'off',
      'coding_agent': 'claude-code',
      'llm.embedding_provider': 'bedrock',
      'llm.embedding_model': 'amazon.titan-embed-text-v2:0',
      'llm.region': 'us-east-1',
      'slack.enabled': 'true',
      'nexus.enabled': 'true',
      'nexus.mcp_enabled': 'true',
      'langfuse.enabled': 'false',
      'runtime.sea': 'false',
      'runtime.node_version': process.version,
      'runtime.platform': process.platform,
      'runtime.arch': process.arch,
      'webhook.receiver_enabled': 'true',
      'cron.tasks': '3',
      'skills.count': '3',
      'agent.subagents': '1',
    });
  });

  it('reports direct routing and omits the region on Azure', async () => {
    setConfig({
      llmProvider: 'azure',
      chatModelId: 'claude-opus-4-8',
      classificationModelId: 'claude-haiku-4-5',
      embeddingProvider: 'azure-openai',
      embeddingModelId: 'text-embedding-3-small',
      nexusLlmBaseUrl: null,
      nexusAzureBaseUrl: null,
      nexusChatBaseUrl: null,
      nexusApiUrl: undefined,
      nexusMcpUrl: null,
      slackBotToken: undefined,
      langfuseSecretKey: 'lf-secret',
      langfusePublicKey: 'lf-public',
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    const props = emittedProps();
    expect(props).toMatchObject({
      'llm.provider': 'azure',
      'llm.routing': 'direct',
      'llm.chat_model': 'claude-opus-4-8',
      'llm.classification_model': 'claude-haiku-4-5',
      'llm.embedding_provider': 'azure-openai',
      'llm.embedding_model': 'text-embedding-3-small',
      'slack.enabled': 'false',
      'nexus.enabled': 'false',
      'nexus.mcp_enabled': 'false',
      'langfuse.enabled': 'true',
      'cron.tasks': '0',
    });
    expect(props).not.toHaveProperty('llm.region');
  });

  it('routes through the gateway on Azure when the Azure gateway base URL is set', async () => {
    setConfig({
      llmProvider: 'azure',
      nexusLlmBaseUrl: null,
      nexusAzureBaseUrl: 'https://gateway.test/llm/azure/anthropic/v1',
      nexusChatBaseUrl: 'https://gateway.test/llm/azure/anthropic/v1',
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(emittedProps()['llm.routing']).toBe('nexus');
  });

  it('reports the region on bedrock-mantle — both AWS endpoints are regional', async () => {
    setConfig({
      llmProvider: 'bedrock-mantle',
      chatModelId: 'anthropic.claude-opus-5',
      classificationModelId: 'anthropic.claude-haiku-4-5-20251001-v1:0',
      nexusLlmBaseUrl: null,
      nexusChatBaseUrl: null,
      nexusApiUrl: undefined,
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(emittedProps()).toMatchObject({
      'llm.provider': 'bedrock-mantle',
      'llm.routing': 'direct',
      'llm.chat_model': 'anthropic.claude-opus-5',
      // Titan on bedrock-runtime — mantle serves no embeddings.
      'llm.embedding_model': 'amazon.titan-embed-text-v2:0',
      'llm.region': 'us-east-1',
    });
  });

  it('routes through the gateway on bedrock-mantle when the mantle mount is set', async () => {
    setConfig({
      llmProvider: 'bedrock-mantle',
      nexusLlmBaseUrl: null,
      nexusBedrockMantleBaseUrl: 'https://gateway.test/llm/bedrock-mantle/anthropic/us-east-1/v1',
      nexusChatBaseUrl: 'https://gateway.test/llm/bedrock-mantle/anthropic/us-east-1/v1',
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(emittedProps()['llm.routing']).toBe('nexus');
  });

  it('reports direct routing and omits the region on OpenAI', async () => {
    setConfig({
      llmProvider: 'openai',
      chatModelId: 'gpt-5.6-sol',
      classificationModelId: 'gpt-5.6-luna',
      embeddingModelId: 'text-embedding-3-small',
      nexusLlmBaseUrl: null,
      nexusChatBaseUrl: null,
      nexusApiUrl: undefined,
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    const props = emittedProps();
    expect(props).toMatchObject({
      'llm.provider': 'openai',
      'llm.routing': 'direct',
      'llm.chat_model': 'gpt-5.6-sol',
      'llm.classification_model': 'gpt-5.6-luna',
      'llm.embedding_model': 'text-embedding-3-small',
    });
    expect(props).not.toHaveProperty('llm.region');
  });

  it('routes through the gateway on OpenAI when the openai mount is set', async () => {
    setConfig({
      llmProvider: 'openai',
      nexusLlmBaseUrl: null,
      nexusChatBaseUrl: 'https://gateway.test/llm/openai/v1',
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(emittedProps()['llm.routing']).toBe('nexus');
  });

  it('reports direct routing and omits the region on Anthropic — even beside Nexus', async () => {
    setConfig({
      llmProvider: 'anthropic',
      chatModelId: 'claude-opus-5',
      classificationModelId: 'claude-haiku-4-5',
      embeddingProvider: 'none',
      embeddingModelId: '',
      // NEXUS_API_URL is set (the bedrock mount exists) but anthropic has no
      // mount, so config resolves the chat mount to null and routing stays
      // direct.
      nexusChatBaseUrl: null,
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    const props = emittedProps();
    expect(props).toMatchObject({
      'llm.provider': 'anthropic',
      'llm.routing': 'direct',
      'llm.chat_model': 'claude-opus-5',
      'llm.classification_model': 'claude-haiku-4-5',
      'llm.embedding_provider': 'none',
    });
    expect(props).not.toHaveProperty('llm.region');
    expect(props).not.toHaveProperty('llm.embedding_model');
  });

  it('omits the embedding model when embeddings are disabled, keeping the provider', async () => {
    setConfig({ embeddingProvider: 'none', embeddingModelId: '' });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    const props = emittedProps();
    expect(props).not.toHaveProperty('llm.embedding_model');
    expect(props).toMatchObject({ 'llm.embedding_provider': 'none' });
  });

  it('gathers nothing when telemetry is disabled', async () => {
    mockIsTelemetryEnabled.mockReturnValue(false);

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(mockTrackEvent).not.toHaveBeenCalled();
    // The skills scan and the subagent query are the expensive part — neither
    // should run on a boot that isn't reporting.
    expect(mockGetCatalog).not.toHaveBeenCalled();
    expect(mockGetSubagents).not.toHaveBeenCalled();
  });

  it('never throws when gathering the census fails', async () => {
    const err = new Error('db is down');
    mockGetSubagents.mockRejectedValue(err);

    await expect(trackAgentStarted(AGENT, { cronTasks: 0 })).resolves.toBeUndefined();

    expect(mockTrackEvent).not.toHaveBeenCalled();
    // The error object (not just its message) is logged, so pino emits the stack.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { err },
      expect.stringContaining('agent-started telemetry failed'),
    );
  });
});
