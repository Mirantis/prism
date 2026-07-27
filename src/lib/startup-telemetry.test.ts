import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTrackEvent, mockGetCatalog, mockGetSubagents, mockConfig, mockLogger } = vi.hoisted(
  () => ({
    mockTrackEvent: vi.fn(),
    mockGetCatalog: vi.fn(),
    mockGetSubagents: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockConfig: {} as Record<string, unknown>,
  }),
);

vi.mock('./telemetry', () => ({ trackEvent: mockTrackEvent, isTelemetryEnabled: () => false }));
vi.mock('../logger', () => ({ logger: mockLogger }));
vi.mock('../config', () => ({ config: mockConfig }));
vi.mock('../services/skill-catalog.service', () => ({
  skillCatalogService: { getCatalog: mockGetCatalog },
}));
vi.mock('../services/agent-workspace.service', () => ({
  agentWorkspaceService: { getSubagents: mockGetSubagents },
}));

import { trackAgentStarted } from './startup-telemetry';

const SLACK_TOKEN = 'xoxb-super-secret';
const AZURE_KEY = 'azure-super-secret';
const OTEL_KEY = 'otel-super-secret';
const DB_URL = 'file:/data/agent.db';

const BEDROCK_CONFIG = {
  llmProvider: 'bedrock',
  chatModelId: 'us.anthropic.claude-opus-4-8',
  classificationModelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  embeddingModelId: 'amazon.titan-embed-text-v2:0',
  awsRegion: 'us-east-1',
  nexusLlmBaseUrl: 'https://nexus.test/llm/bedrock/us-east-1',
  nexusAzureBaseUrl: null,
  nexusApiUrl: 'https://nexus.test',
  nexusMcpUrl: 'https://nexus.test/projects/p1/mcp',
  slackBotToken: SLACK_TOKEN,
  azureApiKey: undefined,
  langfuseSecretKey: undefined,
  langfusePublicKey: undefined,
  otelApiKey: OTEL_KEY,
  databaseUrl: DB_URL,
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
    mockGetCatalog.mockReturnValue([{ name: 'a' }, { name: 'b' }, { name: 'c' }]);
    mockGetSubagents.mockResolvedValue([{ id: 'sub-1' }]);
  });

  it('emits one `agent started` census for a Bedrock + Nexus deployment', async () => {
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
      'llm.embedding_model': 'amazon.titan-embed-text-v2:0',
      'llm.region': 'us-east-1',
      'slack.enabled': 'true',
      'nexus.enabled': 'true',
      'nexus.mcp_enabled': 'true',
      'langfuse.enabled': 'false',
      'runtime.node_version': process.version,
      'runtime.platform': process.platform,
      'runtime.arch': process.arch,
      'webhook.receiver_enabled': 'true',
      'cron.tasks': '3',
      'skills.count': '3',
      'agent.subagents': '1',
    });
    expect(['sea', 'docker', 'source']).toContain(props['runtime.install_mode']);
  });

  it('reports direct routing and omits the region on Azure', async () => {
    setConfig({
      llmProvider: 'azure',
      chatModelId: 'claude-opus-4-8',
      classificationModelId: 'claude-haiku-4-5',
      embeddingModelId: 'text-embedding-3-small',
      nexusLlmBaseUrl: null,
      nexusAzureBaseUrl: null,
      nexusApiUrl: undefined,
      nexusMcpUrl: null,
      slackBotToken: undefined,
      azureApiKey: AZURE_KEY,
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
      'llm.embedding_model': 'text-embedding-3-small',
      'slack.enabled': 'false',
      'nexus.enabled': 'false',
      'nexus.mcp_enabled': 'false',
      'langfuse.enabled': 'true',
      'cron.tasks': '0',
    });
    expect(props).not.toHaveProperty('llm.region');
  });

  it('routes through Nexus on Azure when the Azure Nexus base URL is set', async () => {
    setConfig({
      llmProvider: 'azure',
      nexusLlmBaseUrl: null,
      nexusAzureBaseUrl: 'https://nexus.test/llm/azure/anthropic/v1',
    });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(emittedProps()['llm.routing']).toBe('nexus');
  });

  it('omits the embedding model when embeddings are disabled', async () => {
    setConfig({ embeddingModelId: '' });

    await trackAgentStarted(AGENT, { cronTasks: 0 });

    expect(emittedProps()).not.toHaveProperty('llm.embedding_model');
  });

  it('never emits credentials, URLs or the database path', async () => {
    setConfig({ langfuseSecretKey: 'lf-secret', langfusePublicKey: 'lf-public' });

    await trackAgentStarted(AGENT, { cronTasks: 1 });

    const props = emittedProps();
    const secrets = [SLACK_TOKEN, OTEL_KEY, DB_URL, 'lf-secret', 'lf-public', 'nexus.test'];
    for (const [key, value] of Object.entries(props)) {
      expect(key).not.toMatch(/token|secret|api_key|password/i);
      for (const secret of secrets) {
        expect(value).not.toContain(secret);
      }
    }
  });

  it('never throws when gathering the census fails', async () => {
    mockGetSubagents.mockRejectedValue(new Error('db is down'));

    await expect(trackAgentStarted(AGENT, { cronTasks: 0 })).resolves.toBeUndefined();

    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('agent-started telemetry failed'),
    );
  });
});
