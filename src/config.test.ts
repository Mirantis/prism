/**
 * Config Tests
 *
 * Verifies env var reads and defaults. Unmocks the global config mock
 * from setup.ts so we test the real implementation.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// Undo the global mock from setup.ts
vi.unmock('./config');

// Prevent dotenv from loading .env file during tests
vi.mock('dotenv', () => ({ default: { config: vi.fn() } }));

const { mockWarn } = vi.hoisted(() => ({ mockWarn: vi.fn() }));
vi.mock('./logger', () => ({ logger: { warn: mockWarn } }));

describe('config', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.resetModules();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  async function loadConfig() {
    const mod = await import('./config');
    return mod.config;
  }

  it('reads PORT with default 3003', async () => {
    delete process.env.PORT;
    const cfg = await loadConfig();
    expect(cfg.port).toBe(3003);
  });

  it('defaults the bind to loopback', async () => {
    delete process.env.PRISM_HOST;
    expect((await loadConfig()).host).toBe('127.0.0.1');
  });

  it('reads PRISM_HOST from env', async () => {
    process.env.PRISM_HOST = '0.0.0.0';
    expect((await loadConfig()).host).toBe('0.0.0.0');
  });

  it('falls back to loopback for a whitespace-only PRISM_HOST', async () => {
    process.env.PRISM_HOST = '   ';
    expect((await loadConfig()).host).toBe('127.0.0.1');
  });

  it('reads PORT from env', async () => {
    process.env.PORT = '4000';
    const cfg = await loadConfig();
    expect(cfg.port).toBe(4000);
  });

  it('reads BEDROCK_MODEL_ID with default', async () => {
    delete process.env.BEDROCK_MODEL_ID;
    const cfg = await loadConfig();
    expect(cfg.bedrockModelId).toBe('global.anthropic.claude-opus-5');
  });

  it('reads BEDROCK_CLASSIFICATION_MODEL_ID with default', async () => {
    delete process.env.BEDROCK_CLASSIFICATION_MODEL_ID;
    const cfg = await loadConfig();
    expect(cfg.bedrockClassificationModelId).toBe('global.anthropic.claude-haiku-4-5-20251001-v1:0');
  });

  it('reads AWS_REGION with default us-east-1', async () => {
    delete process.env.AWS_REGION;
    const cfg = await loadConfig();
    expect(cfg.awsRegion).toBe('us-east-1');
  });

  it('reads AWS credential env vars', async () => {
    process.env.AWS_ACCESS_KEY_ID = 'key-123';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-456';
    const cfg = await loadConfig();
    expect(cfg.awsAccessKeyId).toBe('key-123');
    expect(cfg.awsSecretAccessKey).toBe('secret-456');
  });

  it('uses local-owner sentinel when OWNER_USER_ID is unset', async () => {
    delete process.env.OWNER_USER_ID;
    const cfg = await loadConfig();
    expect(cfg.ownerUserId).toBe('00000000-0000-0000-0000-000000000001');
  });

  it('reads OWNER_USER_ID / AGENT_NAME / TEAM_NAME from env', async () => {
    process.env.OWNER_USER_ID = 'owner-uuid';
    process.env.AGENT_NAME = 'Custom';
    process.env.TEAM_NAME = 'Acme';
    const cfg = await loadConfig();
    expect(cfg.ownerUserId).toBe('owner-uuid');
    expect(cfg.agentName).toBe('Custom');
    expect(cfg.teamName).toBe('Acme');
  });

  it('defaults agentName to "Prism" and teamName to "Local"', async () => {
    delete process.env.AGENT_NAME;
    delete process.env.TEAM_NAME;
    const cfg = await loadConfig();
    expect(cfg.agentName).toBe('Prism');
    expect(cfg.teamName).toBe('Local');
  });

  it('reads NEXUS_MCP_URL directly from env', async () => {
    process.env.NEXUS_MCP_URL = 'https://gateway.example.com/projects/proj-42/mcp';
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBe('https://gateway.example.com/projects/proj-42/mcp');
  });

  it('nexusMcpUrl is null when NEXUS_MCP_URL is unset', async () => {
    delete process.env.NEXUS_MCP_URL;
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBeNull();
  });

  it('nexusMcpUrl does not fall back to NEXUS_API_URL', async () => {
    delete process.env.NEXUS_MCP_URL;
    process.env.NEXUS_API_URL = 'https://gateway.example.com';
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBeNull();
  });

  it('nexusLlmBaseUrl is null when NEXUS_API_URL is unset', async () => {
    delete process.env.NEXUS_API_URL;
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBeNull();
  });

  it('builds the auto-resolve LLM URL (/llm/...) when PROJECT_ID is unset', async () => {
    process.env.NEXUS_API_URL = 'https://gateway.example.com';
    delete process.env.PROJECT_ID;
    process.env.AWS_REGION = 'us-east-1';
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBe('https://gateway.example.com/llm/bedrock/us-east-1');
  });

  it('builds the explicit-project LLM URL (/projects/...) when PROJECT_ID is set', async () => {
    process.env.NEXUS_API_URL = 'https://gateway.example.com';
    process.env.PROJECT_ID = 'proj-42';
    process.env.AWS_REGION = 'eu-west-1';
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBe(
      'https://gateway.example.com/projects/proj-42/llm/bedrock/eu-west-1',
    );
  });

  describe('MODELS_DEV_URL', () => {
    it('is null when unset, so the runtime makes no outbound call by default', async () => {
      delete process.env.MODELS_DEV_URL;
      const cfg = await loadConfig();
      expect(cfg.modelsDevUrl).toBeNull();
    });

    it('is null when explicitly empty', async () => {
      // The e2e suites and the SEA smoke test pin the refresh off this way, which
      // matters because they inherit ambient env — a developer's .env must not
      // leak the feature into them.
      process.env.MODELS_DEV_URL = '';
      const cfg = await loadConfig();
      expect(cfg.modelsDevUrl).toBeNull();
    });

    it('is null when whitespace-only', async () => {
      // A blank .env line reads as "off" rather than as an unreachable URL that
      // would warn on every boot.
      process.env.MODELS_DEV_URL = '   ';
      const cfg = await loadConfig();
      expect(cfg.modelsDevUrl).toBeNull();
    });

    it('enables the refresh when a URL is named', async () => {
      process.env.MODELS_DEV_URL = 'https://models.dev/api.json';
      const cfg = await loadConfig();
      expect(cfg.modelsDevUrl).toBe('https://models.dev/api.json');
    });

    it('honours a non-default registry URL', async () => {
      process.env.MODELS_DEV_URL = 'http://fixture.test/api.json';
      const cfg = await loadConfig();
      expect(cfg.modelsDevUrl).toBe('http://fixture.test/api.json');
    });
  });

  describe('TOOL_RISK_GATE_MODE', () => {
    it('defaults to off when unset', async () => {
      delete process.env.TOOL_RISK_GATE_MODE;
      const cfg = await loadConfig();
      expect(cfg.toolRiskGateMode).toBe('off');
      expect(cfg.invalidToolRiskGateMode).toBeNull();
    });

    it.each(['off', 'observe', 'enforce'] as const)('accepts %s', async (mode) => {
      process.env.TOOL_RISK_GATE_MODE = mode;
      const cfg = await loadConfig();
      expect(cfg.toolRiskGateMode).toBe(mode);
      expect(cfg.invalidToolRiskGateMode).toBeNull();
    });

    it('is case-insensitive and trims whitespace', async () => {
      process.env.TOOL_RISK_GATE_MODE = '  ENFORCE  ';
      const cfg = await loadConfig();
      expect(cfg.toolRiskGateMode).toBe('enforce');
      expect(cfg.invalidToolRiskGateMode).toBeNull();
    });

    it('falls back to off and preserves an invalid value for the startup warning', async () => {
      process.env.TOOL_RISK_GATE_MODE = 'enabled';
      const cfg = await loadConfig();
      expect(cfg.toolRiskGateMode).toBe('off');
      expect(cfg.invalidToolRiskGateMode).toBe('enabled');
    });
  });

  describe('CODING_AGENT', () => {
    it('defaults to claude-code when unset', async () => {
      delete process.env.CODING_AGENT;
      const cfg = await loadConfig();
      expect(cfg.codingAgent).toBe('claude-code');
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it.each(['', '   '])('treats a blank value (%j) as unset', async (value) => {
      process.env.CODING_AGENT = value;
      const cfg = await loadConfig();
      expect(cfg.codingAgent).toBe('claude-code');
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('is case-insensitive and trims whitespace', async () => {
      process.env.CODING_AGENT = '  Claude-Code  ';
      const cfg = await loadConfig();
      expect(cfg.codingAgent).toBe('claude-code');
      expect(mockWarn).not.toHaveBeenCalled();
    });

    it('logs an invalid value and falls back to claude-code', async () => {
      process.env.CODING_AGENT = 'codex';
      const cfg = await loadConfig();
      expect(cfg.codingAgent).toBe('claude-code');
      expect(mockWarn).toHaveBeenCalledExactlyOnceWith(
        { configuredAgent: 'codex', effectiveAgent: 'claude-code' },
        '[Startup] invalid CODING_AGENT; using the default',
      );
      expect(cfg).not.toHaveProperty('invalidCodingAgent');
    });
  });

  describe('LLM_PROVIDER selection', () => {
    // These assert built-in defaults, so any model-id var the developer happens
    // to have exported would otherwise leak in through `originalEnv` — and the
    // anthropic cases assert embedding *derivation*, which an ambient
    // EMBEDDING_PROVIDER would override.
    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (/_MODEL_ID$/.test(key)) delete process.env[key];
      }
      delete process.env.EMBEDDING_PROVIDER;
    });

    it('defaults to bedrock when unset', async () => {
      delete process.env.LLM_PROVIDER;
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('bedrock');
      expect(cfg.chatModelId).toBe('global.anthropic.claude-opus-5');
    });

    it('falls back to bedrock on an unrecognized value', async () => {
      process.env.LLM_PROVIDER = 'mantle';
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('bedrock');
    });

    it('selects azure and resolves the neutral model IDs to deployment names', async () => {
      process.env.LLM_PROVIDER = 'azure';
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('azure');
      expect(cfg.chatModelId).toBe('claude-opus-5');
      expect(cfg.classificationModelId).toBe('claude-haiku-4-5');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('selects bedrock-mantle (case-insensitive) and resolves the neutral model IDs', async () => {
      process.env.LLM_PROVIDER = 'Bedrock-Mantle';
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('bedrock-mantle');
      expect(cfg.chatModelId).toBe('anthropic.claude-opus-5');
      // No `-20251001-v1:0` suffix — that is bedrock-runtime's convention and
      // mantle 404s it.
      expect(cfg.classificationModelId).toBe('anthropic.claude-haiku-4-5');
      // Mantle has no embedding surface — Titan on bedrock-runtime.
      expect(cfg.embeddingModelId).toBe('amazon.titan-embed-text-v2:0');
    });

    it('mantle chat/classification defaults are bare (no cross-region prefix)', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      const cfg = await loadConfig();
      expect(cfg.chatModelId).not.toMatch(/^(us|eu|apac|global)\./);
      expect(cfg.classificationModelId).not.toMatch(/^(us|eu|apac|global)\./);
    });

    it('mantle model IDs do NOT inherit the prefixed BEDROCK_* values', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      process.env.BEDROCK_MODEL_ID = 'us.anthropic.claude-opus-4-8';
      const cfg = await loadConfig();
      expect(cfg.chatModelId).toBe('anthropic.claude-opus-5');
    });

    it('BEDROCK_MANTLE_EMBEDDING_MODEL_ID="" disables embeddings', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      process.env.BEDROCK_MANTLE_EMBEDDING_MODEL_ID = '';
      const cfg = await loadConfig();
      expect(cfg.embeddingModelId).toBe('');
    });

    it('selects openrouter and resolves vendor-qualified model IDs', async () => {
      // OpenRouter addresses every model as `vendor/model`, so a bare `gpt-5.6-sol`
      // — correct against api.openai.com — is not a model it can route.
      process.env.LLM_PROVIDER = 'OpenRouter';
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('openrouter');
      expect(cfg.chatModelId).toMatch(/^[a-z0-9-]+\//);
      expect(cfg.classificationModelId).toMatch(/^[a-z0-9-]+\//);
    });

    it('routes openrouter through the openrouter mount, not the openai one', async () => {
      // The mount is what the managed-inference gate checks: a policy selecting
      // openrouter answers 403 on `/llm/openai/*`, so borrowing that path would
      // fail every call.
      process.env.LLM_PROVIDER = 'openrouter';
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
      process.env.PROJECT_ID = 'proj-1';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe(
        'https://gateway.example.com/projects/proj-1/llm/openrouter/openai/v1',
      );
    });

    it('exposes the OpenRouter key and endpoint override for direct mode', async () => {
      // Direct is a supported mode, not just a gateway one: the key rides a
      // header (so it may be a credential sentinel) and the endpoint is
      // overridable like OPENAI_BASE_URL.
      process.env.LLM_PROVIDER = 'openrouter';
      process.env.OPENROUTER_API_KEY = '__nexus_cred:00000000-0000-0000-0000-000000000000__';
      process.env.OPENROUTER_BASE_URL = 'https://proxy.example/openrouter/v1';
      const cfg = await loadConfig();
      expect(cfg.openrouterApiKey).toBe('__nexus_cred:00000000-0000-0000-0000-000000000000__');
      expect(cfg.openrouterEndpoint).toBe('https://proxy.example/openrouter/v1');
    });

    it('disables embeddings on openrouter by default', async () => {
      // OpenRouter is an inference router; its embedding coverage is thin and
      // model-dependent, so defaulting one on would fail at the first index
      // rather than at configuration time. An operator who has one names it.
      process.env.LLM_PROVIDER = 'openrouter';
      const cfg = await loadConfig();
      expect(cfg.embeddingModelId).toBe('');
    });

    it('selects openai (case-insensitive) and resolves the neutral model IDs', async () => {
      process.env.LLM_PROVIDER = 'OpenAI';
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('openai');
      expect(cfg.chatModelId).toBe('gpt-5.6-sol');
      expect(cfg.classificationModelId).toBe('gpt-5.6-luna');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('OPENAI_EMBEDDING_MODEL_ID="" disables embeddings', async () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_EMBEDDING_MODEL_ID = '';
      const cfg = await loadConfig();
      expect(cfg.embeddingModelId).toBe('');
    });

    it('openaiEndpoint is undefined by default (SDK default endpoint)', async () => {
      delete process.env.OPENAI_BASE_URL;
      delete process.env.NEXUS_API_URL;
      expect((await loadConfig()).openaiEndpoint).toBeUndefined();
    });

    it('reads OPENAI_BASE_URL as the endpoint override', async () => {
      delete process.env.NEXUS_API_URL;
      process.env.OPENAI_BASE_URL = 'https://gw.example/openai/v1';
      expect((await loadConfig()).openaiEndpoint).toBe('https://gw.example/openai/v1');
    });

    it('selects anthropic (case-insensitive) and resolves bare first-party model IDs', async () => {
      process.env.LLM_PROVIDER = 'Anthropic';
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('anthropic');
      expect(cfg.chatModelId).toBe('claude-opus-5');
      expect(cfg.classificationModelId).toBe('claude-haiku-4-5');
    });

    it('anthropic without an OpenAI key or gateway runs without embeddings', async () => {
      process.env.LLM_PROVIDER = 'anthropic';
      delete process.env.OPENAI_API_KEY;
      delete process.env.NEXUS_API_URL;
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('none');
      expect(cfg.embeddingModelId).toBe('');
    });

    it('anthropic with an OpenAI key borrows OpenAI embeddings', async () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.OPENAI_API_KEY = 'sk-test';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('openai');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('anthropic without a local key still embeds through the gateway openai mount', async () => {
      // The gateway holds the platform credentials, so a sandbox deployment
      // with no local OPENAI_API_KEY can still reach OpenAI embeddings — the
      // embedding factory sends a decoy key and the gateway injects the real
      // one on the outbound leg.
      process.env.LLM_PROVIDER = 'anthropic';
      delete process.env.OPENAI_API_KEY;
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('openai');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('reads ANTHROPIC_API_KEY verbatim so a credential sentinel survives', async () => {
      process.env.ANTHROPIC_API_KEY = '__nexus_cred:1234-uuid__';
      const cfg = await loadConfig();
      expect(cfg.anthropicApiKey).toBe('__nexus_cred:1234-uuid__');
    });

    it('anthropicBaseUrl is undefined by default (SDK default endpoint)', async () => {
      delete process.env.ANTHROPIC_BASE_URL;
      expect((await loadConfig()).anthropicBaseUrl).toBeUndefined();
    });

    it('reads ANTHROPIC_BASE_URL as the direct endpoint override', async () => {
      process.env.ANTHROPIC_BASE_URL = 'https://gw.example/anthropic/v1';
      expect((await loadConfig()).anthropicBaseUrl).toBe('https://gw.example/anthropic/v1');
    });
  });

  describe('EMBEDDING_PROVIDER selection', () => {
    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (/_MODEL_ID$/.test(key)) delete process.env[key];
      }
      delete process.env.EMBEDDING_PROVIDER;
      delete process.env.LLM_PROVIDER;
    });

    it('derives bedrock from a bedrock chat deployment', async () => {
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('bedrock');
      expect(cfg.embeddingModelId).toBe('amazon.titan-embed-text-v2:0');
    });

    it('derives azure-openai from an azure chat deployment', async () => {
      process.env.LLM_PROVIDER = 'azure';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('azure-openai');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('derives bedrock from a bedrock-mantle chat deployment (Titan)', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('bedrock');
      expect(cfg.embeddingModelId).toBe('amazon.titan-embed-text-v2:0');
    });

    it('derives openai from an openai chat deployment', async () => {
      process.env.LLM_PROVIDER = 'openai';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('openai');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('derives openrouter from an openrouter chat deployment, embeddings off by default', async () => {
      process.env.LLM_PROVIDER = 'openrouter';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('openrouter');
      expect(cfg.embeddingModelId).toBe('');
    });

    it('openrouter embeddings switch on when a model id is named', async () => {
      process.env.LLM_PROVIDER = 'openrouter';
      process.env.OPENROUTER_EMBEDDING_MODEL_ID = 'openai/text-embedding-3-small';
      const cfg = await loadConfig();
      expect(cfg.embeddingModelId).toBe('openai/text-embedding-3-small');
    });

    it('an explicit EMBEDDING_PROVIDER wins over the derived default', async () => {
      process.env.LLM_PROVIDER = 'bedrock';
      process.env.EMBEDDING_PROVIDER = 'openai';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('openai');
      expect(cfg.embeddingModelId).toBe('text-embedding-3-small');
    });

    it('is case-insensitive and tolerates stray whitespace', async () => {
      // A quoted compose value like "none " must not silently leave
      // embeddings on — the exact opposite of the request.
      for (const messy of ['Azure-OpenAI', ' azure-openai ', 'AZURE-OPENAI']) {
        process.env.EMBEDDING_PROVIDER = messy;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.embeddingProvider).toBe('azure-openai');
      }
    });

    it('none disables embeddings entirely', async () => {
      process.env.EMBEDDING_PROVIDER = 'none';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('none');
      expect(cfg.embeddingModelId).toBe('');
      expect(cfg.invalidEmbeddingProvider).toBeNull();
    });

    it('falls back to the derived default on an unrecognized value, preserving it for the startup warning', async () => {
      // A typo like EMBEDDING_PROVIDER=azure (meaning azure-openai) keeps the
      // derived default running, so nothing ever looks broken — the preserved
      // value is what index.ts warns with at boot.
      process.env.EMBEDDING_PROVIDER = 'voyage';
      const cfg = await loadConfig();
      expect(cfg.embeddingProvider).toBe('bedrock');
      expect(cfg.invalidEmbeddingProvider).toBe('voyage');
    });

    it('unset is not invalid — it is the documented way to ask for the default', async () => {
      delete process.env.EMBEDDING_PROVIDER;
      const cfg = await loadConfig();
      expect(cfg.invalidEmbeddingProvider).toBeNull();
    });

    it('mantle carve-out: BEDROCK_MANTLE_EMBEDDING_MODEL_ID="" disables even under an explicit bedrock selection', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      process.env.EMBEDDING_PROVIDER = 'bedrock';
      process.env.BEDROCK_MANTLE_EMBEDDING_MODEL_ID = '';
      const cfg = await loadConfig();
      expect(cfg.embeddingModelId).toBe('');
    });
  });

  describe('bedrock-mantle endpoints', () => {
    it('derives the direct endpoint from AWS_REGION, ending at /anthropic/v1', async () => {
      process.env.AWS_REGION = 'eu-central-1';
      const cfg = await loadConfig();
      expect(cfg.bedrockMantleDirectEndpoint).toBe(
        'https://bedrock-mantle.eu-central-1.api.aws/anthropic/v1',
      );
    });

    it('BEDROCK_MANTLE_BASE_URL overrides the derived endpoint', async () => {
      process.env.BEDROCK_MANTLE_BASE_URL = 'https://mantle.internal/anthropic/v1';
      const cfg = await loadConfig();
      expect(cfg.bedrockMantleDirectEndpoint).toBe('https://mantle.internal/anthropic/v1');
    });

    it('reads the Bedrock API key from AWS_BEARER_TOKEN_BEDROCK', async () => {
      process.env.AWS_BEARER_TOKEN_BEDROCK = 'bedrock-api-key';
      const cfg = await loadConfig();
      expect(cfg.bedrockApiKey).toBe('bedrock-api-key');
    });

    it('nexusBedrockMantleBaseUrl is null when NEXUS_API_URL is unset', async () => {
      delete process.env.NEXUS_API_URL;
      const cfg = await loadConfig();
      expect(cfg.nexusBedrockMantleBaseUrl).toBeNull();
    });

    it('builds the auto-resolve mantle mount when PROJECT_ID is unset', async () => {
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
      delete process.env.PROJECT_ID;
      process.env.AWS_REGION = 'us-east-1';
      const cfg = await loadConfig();
      expect(cfg.nexusBedrockMantleBaseUrl).toBe(
        'https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1',
      );
    });

    it('builds the explicit-project mantle mount when PROJECT_ID is set', async () => {
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
      process.env.PROJECT_ID = 'proj-42';
      process.env.AWS_REGION = 'eu-west-1';
      const cfg = await loadConfig();
      expect(cfg.nexusBedrockMantleBaseUrl).toBe(
        'https://gateway.example.com/projects/proj-42/llm/bedrock-mantle/anthropic/eu-west-1/v1',
      );
    });
  });

  describe('nexusChatBaseUrl', () => {
    beforeEach(() => {
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
      delete process.env.PROJECT_ID;
      process.env.AWS_REGION = 'us-east-1';
    });

    it('is the bedrock-runtime mount on bedrock', async () => {
      process.env.LLM_PROVIDER = 'bedrock';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe('https://gateway.example.com/llm/bedrock/us-east-1');
    });

    it('is the azure anthropic mount on azure', async () => {
      process.env.LLM_PROVIDER = 'azure';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe('https://gateway.example.com/llm/azure/anthropic/v1');
    });

    it('is the mantle mount on bedrock-mantle, not the bedrock-runtime one', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe(
        'https://gateway.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1',
      );
      // The bedrock-runtime mount stays available — it carries the Titan leg.
      expect(cfg.nexusLlmBaseUrl).toBe('https://gateway.example.com/llm/bedrock/us-east-1');
    });

    it('is the openai mount on openai', async () => {
      process.env.LLM_PROVIDER = 'openai';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe('https://gateway.example.com/llm/openai/v1');
      expect(cfg.nexusOpenAiBaseUrl).toBe('https://gateway.example.com/llm/openai/v1');
    });

    it('builds the explicit-project openai mount when PROJECT_ID is set', async () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.PROJECT_ID = 'proj-42';
      const cfg = await loadConfig();
      expect(cfg.nexusOpenAiBaseUrl).toBe(
        'https://gateway.example.com/projects/proj-42/llm/openai/v1',
      );
    });

    it('is null for every provider when NEXUS_API_URL is unset', async () => {
      delete process.env.NEXUS_API_URL;
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBeNull();
    });

    it('is null on openai when NEXUS_API_URL is unset (direct to api.openai.com)', async () => {
      delete process.env.NEXUS_API_URL;
      process.env.LLM_PROVIDER = 'openai';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBeNull();
      expect(cfg.nexusOpenAiBaseUrl).toBeNull();
    });

    it('is null on anthropic even when NEXUS_API_URL is set — no mount serves api.anthropic.com', async () => {
      process.env.LLM_PROVIDER = 'anthropic';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBeNull();
    });
  });

  describe('endpoint precedence: override, then gateway mount, then vendor host', () => {
    beforeEach(() => {
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
      delete process.env.PROJECT_ID;
      process.env.AWS_REGION = 'us-east-1';
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENROUTER_BASE_URL;
      delete process.env.AZURE_FOUNDRY_BASE_URL;
      delete process.env.BEDROCK_MANTLE_BASE_URL;
      delete process.env.AZURE_RESOURCE_NAME;
    });

    it('OPENAI_BASE_URL wins over the derived openai mount', async () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_BASE_URL =
        'https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1';
      const cfg = await loadConfig();
      expect(cfg.openaiEndpoint).toBe(
        'https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1',
      );
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('OPENROUTER_BASE_URL wins over the derived openrouter mount', async () => {
      process.env.LLM_PROVIDER = 'openrouter';
      process.env.OPENROUTER_BASE_URL = 'https://proxy.example/openrouter/v1';
      const cfg = await loadConfig();
      expect(cfg.openrouterEndpoint).toBe('https://proxy.example/openrouter/v1');
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('AZURE_FOUNDRY_BASE_URL wins over the derived azure mount', async () => {
      process.env.LLM_PROVIDER = 'azure';
      process.env.AZURE_RESOURCE_NAME = 'example-resource';
      process.env.AZURE_FOUNDRY_BASE_URL = 'https://foundry.example/anthropic/v1';
      const cfg = await loadConfig();
      expect(cfg.azureChatEndpoint).toBe('https://foundry.example/anthropic/v1');
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('BEDROCK_MANTLE_BASE_URL wins over the derived mantle mount', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      process.env.BEDROCK_MANTLE_BASE_URL = 'https://mantle.internal/anthropic/v1';
      const cfg = await loadConfig();
      expect(cfg.bedrockMantleChatEndpoint).toBe('https://mantle.internal/anthropic/v1');
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('takes the gateway mount when no override is set', async () => {
      process.env.LLM_PROVIDER = 'openai';
      const cfg = await loadConfig();
      expect(cfg.openaiEndpoint).toBe('https://gateway.example.com/llm/openai/v1');
      expect(cfg.chatEndpointSource).toBe('gateway');
      expect(cfg.chatRouting).toBe('nexus');
    });

    it.each(['azure', 'bedrock-mantle', 'openrouter'] as const)(
      '%s with no override takes its own gateway mount',
      async (provider) => {
        process.env.LLM_PROVIDER = provider;
        process.env.AZURE_RESOURCE_NAME = 'example-resource';
        const cfg = await loadConfig();
        expect(cfg.chatEndpointSource).toBe('gateway');
        expect(cfg.chatRouting).toBe('nexus');
      },
    );

    it('takes the vendor host when neither an override nor a gateway is set', async () => {
      delete process.env.NEXUS_API_URL;
      process.env.LLM_PROVIDER = 'openrouter';
      const cfg = await loadConfig();
      expect(cfg.openrouterEndpoint).toBe('https://openrouter.ai/api/v1');
      expect(cfg.azureChatEndpoint).toBeUndefined();
      expect(cfg.bedrockMantleChatEndpoint).toBe(
        'https://bedrock-mantle.us-east-1.api.aws/anthropic/v1',
      );
      expect(cfg.chatEndpointSource).toBe('direct');
      expect(cfg.chatRouting).toBe('direct');
    });

    it('an override off the gateway host routes direct, gateway or not', async () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_BASE_URL = 'https://api.openai.example/v1';
      const cfg = await loadConfig();
      expect(cfg.chatRouting).toBe('direct');
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('an override on the gateway host still routes through the gateway', async () => {
      // `override` says the operator named the endpoint, `nexus` says the
      // gateway still holds the vendor key.
      process.env.LLM_PROVIDER = 'openai';
      process.env.OPENAI_BASE_URL =
        'https://gateway.example.com/llm/bedrock-mantle/openai/us-east-1/v1';
      const cfg = await loadConfig();
      expect(cfg.chatRouting).toBe('nexus');
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('anthropic ignores the gateway and reports its own endpoint', async () => {
      process.env.LLM_PROVIDER = 'anthropic';
      process.env.ANTHROPIC_BASE_URL = 'https://anthropic.example/v1';
      const cfg = await loadConfig();
      expect(cfg.chatRouting).toBe('direct');
      expect(cfg.chatEndpointSource).toBe('override');
    });

    it('bedrock reports the gateway mount it already used', async () => {
      process.env.LLM_PROVIDER = 'bedrock';
      const cfg = await loadConfig();
      expect(cfg.chatEndpointSource).toBe('gateway');
      expect(cfg.chatRouting).toBe('nexus');
    });
  });

  describe('isGatewayEndpoint', () => {
    beforeEach(() => {
      process.env.NEXUS_API_URL = 'https://gateway.example.com';
    });

    async function loadIsGatewayEndpoint() {
      const mod = await import('./config');
      return mod.isGatewayEndpoint;
    }

    it('matches any mount on the gateway host, whatever the path', async () => {
      const isGatewayEndpoint = await loadIsGatewayEndpoint();
      expect(isGatewayEndpoint('https://gateway.example.com/llm/openai/v1')).toBe(true);
      expect(isGatewayEndpoint('https://GATEWAY.example.com/projects/p/llm/openrouter/openai/v1')).toBe(
        true,
      );
      expect(isGatewayEndpoint('https://gateway.example.com:443/llm/openai/v1')).toBe(true);
    });

    it('rejects another host, another scheme and another port', async () => {
      const isGatewayEndpoint = await loadIsGatewayEndpoint();
      expect(isGatewayEndpoint('https://api.openai.example/v1')).toBe(false);
      expect(isGatewayEndpoint('http://gateway.example.com/llm/openai/v1')).toBe(false);
      expect(isGatewayEndpoint('https://gateway.example.com:8443/llm/openai/v1')).toBe(false);
    });

    it('answers false for an unset or unparseable endpoint', async () => {
      const isGatewayEndpoint = await loadIsGatewayEndpoint();
      expect(isGatewayEndpoint(undefined)).toBe(false);
      expect(isGatewayEndpoint(null)).toBe(false);
      expect(isGatewayEndpoint('')).toBe(false);
      expect(isGatewayEndpoint('not-a-url')).toBe(false);
    });

    it('answers false for every endpoint when no gateway is configured', async () => {
      delete process.env.NEXUS_API_URL;
      const isGatewayEndpoint = await loadIsGatewayEndpoint();
      expect(isGatewayEndpoint('https://gateway.example.com/llm/openai/v1')).toBe(false);
    });

    it('answers false when NEXUS_API_URL names no http scheme', async () => {
      // Every opaque URL takes the origin "null", so two of them compare equal.
      // Such a gateway fails in `fetch` anyway, and it must not hand a decoy key
      // to an unrelated endpoint on the way there.
      process.env.NEXUS_API_URL = 'gateway.example.com:8443';
      const isGatewayEndpoint = await loadIsGatewayEndpoint();
      expect(isGatewayEndpoint('gateway.example.com:8443')).toBe(false);
      expect(isGatewayEndpoint('mailto:operator@endpoint.example')).toBe(false);
    });
  });

  describe('chatEndpointForLog', () => {
    beforeEach(() => {
      delete process.env.NEXUS_API_URL;
      process.env.LLM_PROVIDER = 'openai';
    });

    it('keeps origin and path only, so no credential reaches the log', async () => {
      // Invented values: a userinfo password and a query token, both of which a
      // full URL would print.
      process.env.OPENAI_BASE_URL =
        'https://operator:invented-p4ssw0rd@endpoint.example/llm/openai/v1?api_key=invented-token';
      const cfg = await loadConfig();
      expect(cfg.chatEndpointForLog).toBe('https://endpoint.example/llm/openai/v1');
      expect(cfg.chatEndpointForLog).not.toContain('invented-p4ssw0rd');
      expect(cfg.chatEndpointForLog).not.toContain('invented-token');
    });

    it('names an unparseable endpoint rather than printing it', async () => {
      process.env.OPENAI_BASE_URL = 'endpoint.example/v1?api_key=invented-token';
      const cfg = await loadConfig();
      expect(cfg.chatEndpointForLog).toBe('invalid');
    });

    it('says so when the vendor default applies', async () => {
      delete process.env.OPENAI_BASE_URL;
      const cfg = await loadConfig();
      expect(cfg.chatEndpointForLog).toBe('vendor default');
    });
  });

  describe('compaction', () => {
    it('defaults the threshold to 90 and the tail to 6', async () => {
      delete process.env.COMPACTION_THRESHOLD_PERCENT;
      delete process.env.COMPACTION_TAIL_MESSAGES;
      const cfg = await loadConfig();
      expect(cfg.compactionThresholdPercent).toBe(90);
      expect(cfg.compactionTailMessages).toBe(6);
    });

    it('reads a threshold override', async () => {
      process.env.COMPACTION_THRESHOLD_PERCENT = '75';
      const cfg = await loadConfig();
      expect(cfg.compactionThresholdPercent).toBe(75);
    });

    it('treats 0 as "auto-compaction disabled"', async () => {
      process.env.COMPACTION_THRESHOLD_PERCENT = '0';
      const cfg = await loadConfig();
      expect(cfg.compactionThresholdPercent).toBeNull();
    });

    it('falls back to the default on junk or out-of-range thresholds', async () => {
      // Junk must not silently disable a safety feature, and >100 can never fire.
      for (const bad of ['nonsense', '-5', '101']) {
        process.env.COMPACTION_THRESHOLD_PERCENT = bad;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.compactionThresholdPercent).toBe(90);
      }
    });

    it('reads the tail override, allowing 0', async () => {
      process.env.COMPACTION_TAIL_MESSAGES = '0';
      const cfg = await loadConfig();
      expect(cfg.compactionTailMessages).toBe(0);
    });

    it('falls back to the default tail on junk or negative values', async () => {
      for (const bad of ['nope', '-1']) {
        process.env.COMPACTION_TAIL_MESSAGES = bad;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.compactionTailMessages).toBe(6);
      }
    });
  });

  describe('voice meetings', () => {
    it('leaves the OpenAI key undefined when unset, which disables the feature', async () => {
      delete process.env.OPENAI_API_KEY;
      const cfg = await loadConfig();
      expect(cfg.openaiApiKey).toBeUndefined();
    });

    it('reads the OpenAI key verbatim so a credential sentinel survives', async () => {
      // The sandbox MITM swaps this on the wire; config must not touch it.
      process.env.OPENAI_API_KEY = '__nexus_cred:1234-uuid__';
      const cfg = await loadConfig();
      expect(cfg.openaiApiKey).toBe('__nexus_cred:1234-uuid__');
    });

    it('pins the realtime model to a snapshot rather than the moving alias', async () => {
      // The `gpt-realtime` alias follows OpenAI's current snapshot, so turn-taking
              // and prosody could change under a live deployment with no code change.
      delete process.env.OPENAI_REALTIME_MODEL;
      const cfg = await loadConfig();
      expect(cfg.openaiRealtimeModel).toBe('gpt-realtime-2.1');
    });

    it('reads a realtime model override', async () => {
      process.env.OPENAI_REALTIME_MODEL = 'gpt-realtime-mini';
      const cfg = await loadConfig();
      expect(cfg.openaiRealtimeModel).toBe('gpt-realtime-mini');
    });

    it('names a voice rather than accepting the API default', async () => {
      // `marin` is materially better for conversation than the default `alloy`.
      delete process.env.OPENAI_REALTIME_VOICE;
      const cfg = await loadConfig();
      expect(cfg.openaiRealtimeVoice).toBe('marin');
    });

    it('allows overriding the voice, in case a model retires the name', async () => {
      process.env.OPENAI_REALTIME_VOICE = 'cedar';
      const cfg = await loadConfig();
      expect(cfg.openaiRealtimeVoice).toBe('cedar');
    });

    it('asks for high reasoning effort rather than taking the API default', async () => {
      // The API defaults to `low`, which suits a voice agent that reads out an
      // order status. This one runs shell commands and kubectl from a call.
      delete process.env.OPENAI_REALTIME_REASONING_EFFORT;
      const cfg = await loadConfig();
      expect(cfg.openaiRealtimeReasoningEffort).toBe('high');
    });

    it('reads a reasoning effort override', async () => {
      for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh']) {
        process.env.OPENAI_REALTIME_REASONING_EFFORT = level;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.openaiRealtimeReasoningEffort).toBe(level);
      }
    });

    it('hands the level back to the API when set empty', async () => {
      for (const empty of ['', '   ']) {
        process.env.OPENAI_REALTIME_REASONING_EFFORT = empty;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.openaiRealtimeReasoningEffort).toBeNull();
      }
    });

    it('tolerates case and stray whitespace around a level', async () => {
      // The fallback raises the effort, so a mangled `medium` would cost the
      // operator latency they were explicitly trying to buy back.
      for (const messy of [' medium', 'Medium', 'MEDIUM ']) {
        process.env.OPENAI_REALTIME_REASONING_EFFORT = messy;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.openaiRealtimeReasoningEffort).toBe('medium');
      }
    });

    it('falls back to the default on an unrecognized level', async () => {
      // A typo should cost accuracy in a call, not the boot.
      for (const bad of ['very-high', 'none', 'off', '3']) {
        process.env.OPENAI_REALTIME_REASONING_EFFORT = bad;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.openaiRealtimeReasoningEffort).toBe('high');
      }
    });

    it('defaults the call duration cap to 60 minutes', async () => {
      delete process.env.MEETING_TIMEOUT_MINUTES;
      const cfg = await loadConfig();
      expect(cfg.meetingTimeoutMinutes).toBe(60);
    });

    it('reads a duration cap override', async () => {
      process.env.MEETING_TIMEOUT_MINUTES = '15';
      const cfg = await loadConfig();
      expect(cfg.meetingTimeoutMinutes).toBe(15);
    });

    it('falls back to the default cap on junk or non-positive values', async () => {
      // A meeting with no cap could hold a browser and a metered socket forever.
      for (const bad of ['soon', '0', '-10']) {
        process.env.MEETING_TIMEOUT_MINUTES = bad;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.meetingTimeoutMinutes).toBe(60);
      }
    });

    it('defaults the admission wait to five minutes, in milliseconds', async () => {
      delete process.env.MEETING_ADMISSION_TIMEOUT_SECONDS;
      const cfg = await loadConfig();
      expect(cfg.meetingAdmissionTimeoutMs).toBe(300_000);
    });

    it('converts an admission wait override from seconds', async () => {
      process.env.MEETING_ADMISSION_TIMEOUT_SECONDS = '30';
      const cfg = await loadConfig();
      expect(cfg.meetingAdmissionTimeoutMs).toBe(30_000);
    });

    it('falls back to the default admission wait on junk', async () => {
      for (const bad of ['later', '0']) {
        process.env.MEETING_ADMISSION_TIMEOUT_SECONDS = bad;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.meetingAdmissionTimeoutMs).toBe(300_000);
      }
    });

    it('keeps a meeting out of the logs unless asked', async () => {
      // The room is unauthenticated and consented to nothing about this deployment's
      // logs, so the words are opt-in rather than opt-out.
      delete process.env.MEETING_TRANSCRIPT_LOGGING;
      const cfg = await loadConfig();
      expect(cfg.meetingTranscriptLogging).toBe('off');
    });

    it('reads the setting that logs the words', async () => {
      process.env.MEETING_TRANSCRIPT_LOGGING = 'full';
      const cfg = await loadConfig();
      expect(cfg.meetingTranscriptLogging).toBe('full');
    });

    it('tolerates case and stray whitespace around a mode', async () => {
      for (const messy of ['FULL ', ' Full']) {
        process.env.MEETING_TRANSCRIPT_LOGGING = messy;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.meetingTranscriptLogging).toBe('full');
      }
    });

    it('falls back to logging nothing on a value it does not recognize', async () => {
      // Including every plausible way of writing "on": a typo here should cost a
      // diagnostic, not the boot — and it must not fail *open* into a transcript.
      // `redacted` is in the list because it is the obvious guess at a middle
      // setting, and guessing wrong must land on silence rather than on the words.
      for (const bad of ['on', 'true', '1', 'verbose', 'redacted']) {
        process.env.MEETING_TRANSCRIPT_LOGGING = bad;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.meetingTranscriptLogging).toBe('off');
      }
    });

    it('treats an empty value as off rather than as a default to defer', async () => {
      // Deliberately unlike OPENAI_REALTIME_REASONING_EFFORT, where empty means "let
      // the API choose". There is no API to defer to here, so empty means no logging.
      for (const empty of ['', '   ']) {
        process.env.MEETING_TRANSCRIPT_LOGGING = empty;
        vi.resetModules();
        const cfg = await loadConfig();
        expect(cfg.meetingTranscriptLogging).toBe('off');
      }
    });

    it('has no switch for a posted chat message', async () => {
      // There is nothing to switch: a message the agent posts into a call's chat never
      // reaches a log line, so the setting that used to allow it is gone rather than
      // defaulted to off.
      process.env.MEETING_CHAT_LOGGING = 'full';
      vi.resetModules();
      const cfg = await loadConfig();
      expect(cfg).not.toHaveProperty('meetingChatLogging');
    });

    it('has no display-name setting', async () => {
      // Removed rather than defaulted: participants see the Google account's own
      // name, and the only path the setting applied to is the guest join Meet
      // auto-denies. It survives as a per-join argument for a platform that
      // admits named guests.
      const cfg = await loadConfig();
      expect(cfg).not.toHaveProperty('meetingDisplayName');
    });
  });
});
