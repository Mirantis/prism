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

  it('reads PORT from env', async () => {
    process.env.PORT = '4000';
    const cfg = await loadConfig();
    expect(cfg.port).toBe(4000);
  });

  it('reads BEDROCK_MODEL_ID with default', async () => {
    delete process.env.BEDROCK_MODEL_ID;
    const cfg = await loadConfig();
    expect(cfg.bedrockModelId).toBe('us.anthropic.claude-opus-5');
  });

  it('reads BEDROCK_CLASSIFICATION_MODEL_ID with default', async () => {
    delete process.env.BEDROCK_CLASSIFICATION_MODEL_ID;
    const cfg = await loadConfig();
    expect(cfg.bedrockClassificationModelId).toBe('us.anthropic.claude-haiku-4-5-20251001-v1:0');
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
    process.env.NEXUS_MCP_URL = 'https://nexus.example.com/projects/proj-42/mcp';
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBe('https://nexus.example.com/projects/proj-42/mcp');
  });

  it('nexusMcpUrl is null when NEXUS_MCP_URL is unset', async () => {
    delete process.env.NEXUS_MCP_URL;
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBeNull();
  });

  it('nexusMcpUrl does not fall back to NEXUS_API_URL', async () => {
    delete process.env.NEXUS_MCP_URL;
    process.env.NEXUS_API_URL = 'https://nexus.example.com';
    const cfg = await loadConfig();
    expect(cfg.nexusMcpUrl).toBeNull();
  });

  it('nexusLlmBaseUrl is null when NEXUS_API_URL is unset', async () => {
    delete process.env.NEXUS_API_URL;
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBeNull();
  });

  it('builds the auto-resolve LLM URL (/llm/...) when PROJECT_ID is unset', async () => {
    process.env.NEXUS_API_URL = 'https://nexus.example.com';
    delete process.env.PROJECT_ID;
    process.env.AWS_REGION = 'us-east-1';
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBe('https://nexus.example.com/llm/bedrock/us-east-1');
  });

  it('builds the explicit-project LLM URL (/projects/...) when PROJECT_ID is set', async () => {
    process.env.NEXUS_API_URL = 'https://nexus.example.com';
    process.env.PROJECT_ID = 'proj-42';
    process.env.AWS_REGION = 'eu-west-1';
    const cfg = await loadConfig();
    expect(cfg.nexusLlmBaseUrl).toBe(
      'https://nexus.example.com/projects/proj-42/llm/bedrock/eu-west-1',
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

  describe('LLM_PROVIDER selection', () => {
    // These assert built-in defaults, so any model-id var the developer happens
    // to have exported would otherwise leak in through `originalEnv`.
    beforeEach(() => {
      for (const key of Object.keys(process.env)) {
        if (/_MODEL_ID$/.test(key)) delete process.env[key];
      }
    });

    it('defaults to bedrock when unset', async () => {
      delete process.env.LLM_PROVIDER;
      const cfg = await loadConfig();
      expect(cfg.llmProvider).toBe('bedrock');
      expect(cfg.chatModelId).toBe('us.anthropic.claude-opus-5');
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

    it('openaiBaseUrl is undefined by default (SDK default endpoint)', async () => {
      delete process.env.OPENAI_BASE_URL;
      expect((await loadConfig()).openaiBaseUrl).toBeUndefined();
    });

    it('reads OPENAI_BASE_URL as the direct endpoint override', async () => {
      process.env.OPENAI_BASE_URL = 'https://gw.example/openai/v1';
      expect((await loadConfig()).openaiBaseUrl).toBe('https://gw.example/openai/v1');
    });
  });

  describe('bedrock-mantle endpoints', () => {
    it('derives the direct endpoint from AWS_REGION, ending at /anthropic/v1', async () => {
      process.env.AWS_REGION = 'eu-central-1';
      const cfg = await loadConfig();
      expect(cfg.bedrockMantleBaseUrl).toBe(
        'https://bedrock-mantle.eu-central-1.api.aws/anthropic/v1',
      );
    });

    it('BEDROCK_MANTLE_BASE_URL overrides the derived endpoint', async () => {
      process.env.BEDROCK_MANTLE_BASE_URL = 'https://mantle.internal/anthropic/v1';
      const cfg = await loadConfig();
      expect(cfg.bedrockMantleBaseUrl).toBe('https://mantle.internal/anthropic/v1');
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
      process.env.NEXUS_API_URL = 'https://nexus.example.com';
      delete process.env.PROJECT_ID;
      process.env.AWS_REGION = 'us-east-1';
      const cfg = await loadConfig();
      expect(cfg.nexusBedrockMantleBaseUrl).toBe(
        'https://nexus.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1',
      );
    });

    it('builds the explicit-project mantle mount when PROJECT_ID is set', async () => {
      process.env.NEXUS_API_URL = 'https://nexus.example.com';
      process.env.PROJECT_ID = 'proj-42';
      process.env.AWS_REGION = 'eu-west-1';
      const cfg = await loadConfig();
      expect(cfg.nexusBedrockMantleBaseUrl).toBe(
        'https://nexus.example.com/projects/proj-42/llm/bedrock-mantle/anthropic/eu-west-1/v1',
      );
    });
  });

  describe('nexusChatBaseUrl', () => {
    beforeEach(() => {
      process.env.NEXUS_API_URL = 'https://nexus.example.com';
      delete process.env.PROJECT_ID;
      process.env.AWS_REGION = 'us-east-1';
    });

    it('is the bedrock-runtime mount on bedrock', async () => {
      process.env.LLM_PROVIDER = 'bedrock';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe('https://nexus.example.com/llm/bedrock/us-east-1');
    });

    it('is the azure anthropic mount on azure', async () => {
      process.env.LLM_PROVIDER = 'azure';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe('https://nexus.example.com/llm/azure/anthropic/v1');
    });

    it('is the mantle mount on bedrock-mantle, not the bedrock-runtime one', async () => {
      process.env.LLM_PROVIDER = 'bedrock-mantle';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe(
        'https://nexus.example.com/llm/bedrock-mantle/anthropic/us-east-1/v1',
      );
      // The bedrock-runtime mount stays available — it carries the Titan leg.
      expect(cfg.nexusLlmBaseUrl).toBe('https://nexus.example.com/llm/bedrock/us-east-1');
    });

    it('is the openai mount on openai', async () => {
      process.env.LLM_PROVIDER = 'openai';
      const cfg = await loadConfig();
      expect(cfg.nexusChatBaseUrl).toBe('https://nexus.example.com/llm/openai/v1');
      expect(cfg.nexusOpenAiBaseUrl).toBe('https://nexus.example.com/llm/openai/v1');
    });

    it('builds the explicit-project openai mount when PROJECT_ID is set', async () => {
      process.env.LLM_PROVIDER = 'openai';
      process.env.PROJECT_ID = 'proj-42';
      const cfg = await loadConfig();
      expect(cfg.nexusOpenAiBaseUrl).toBe(
        'https://nexus.example.com/projects/proj-42/llm/openai/v1',
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
