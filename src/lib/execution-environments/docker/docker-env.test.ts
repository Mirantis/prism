import { describe, expect, it } from 'vitest';
import { dockerBaseEnv } from './docker-env';

describe('dockerBaseEnv', () => {
  it("keeps the runtime's own credentials out of the container", () => {
    const env = dockerBaseEnv({
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_APP_TOKEN: 'xapp-test',
      TEAMS_APP_ID: 'test-app-id',
      TEAMS_APP_PASSWORD: 'test-client-secret',
      TEAMS_APP_TENANT_ID: 'test-tenant-id',
      GOOGLE_BOT_EMAIL: 'bot@example.test',
      GOOGLE_BOT_PASSWORD: 'test-password',
      LANGFUSE_SECRET_KEY: 'test-secret',
      OTEL_EXPORTER_OTLP_API_KEY: 'test-otel-key',
      NEXUS_API_URL: 'https://nexus.example.test',
      OPENAI_REALTIME_API_KEY: 'test-realtime-key',
    });
    // With any of these the agent's shell could post as the Slack or Teams bot
    // or sign in to the meeting account.
    expect(env).toEqual({});
  });

  it('keeps the credentials the agent works with', () => {
    const env = dockerBaseEnv({
      AWS_BEARER_TOKEN_BEDROCK: 'test-token',
      ANTHROPIC_API_KEY: 'test-key',
      OPENAI_API_KEY: 'test-key',
      GH_TOKEN: 'test-token',
    });
    // The coding agents and the agent's own CLIs authenticate with these.
    expect(Object.keys(env).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'AWS_BEARER_TOKEN_BEDROCK',
      'GH_TOKEN',
      'OPENAI_API_KEY',
    ]);
  });

  it("drops the runtime's own server wiring", () => {
    const env = dockerBaseEnv({
      PORT: '3003',
      PRISM_HOST: '0.0.0.0',
      PRISM_ALLOWED_ORIGINS: 'https://app.example.com',
    });
    // The pair goes together: one without the other stops a nested runtime's startup.
    expect(env).toEqual({});
  });

  it('drops a variable that names a path or socket on this machine', () => {
    const env = dockerBaseEnv({
      KUBECONFIG: '/Users/me/.kube/config',
      AWS_PROFILE: 'work',
      AWS_CONFIG_FILE: '/Users/me/.aws/config',
      AWS_SHARED_CREDENTIALS_FILE: '/Users/me/.aws/credentials',
      SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
      DOCKER_HOST: 'unix:///Users/me/.docker/run/docker.sock',
      CLAUDE_CONFIG_DIR: '/Users/me/.claude',
    });
    expect(env).toEqual({});
  });
});
