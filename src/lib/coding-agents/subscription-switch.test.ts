import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, config } = vi.hoisted(() => ({
  state: new Map<string, string>(),
  config: { claudeCodeSubscription: false, codexSubscription: false },
}));

vi.mock('../../config', async (original) => ({
  ...(await original<typeof import('../../config')>()),
  config,
}));
vi.mock('../../services/runtime-state.service', () => ({
  runtimeStateService: {
    get: vi.fn(async (key: string) => state.get(key) ?? null),
    set: vi.fn(async (key: string, value: string) => void state.set(key, value)),
    delete: vi.fn(async (key: string) => void state.delete(key)),
  },
}));

import { runtimeStateService } from '../../services/runtime-state.service';

describe('subscription switch', () => {
  beforeEach(() => {
    vi.resetModules();
    state.clear();
    config.claudeCodeSubscription = false;
    config.codexSubscription = false;
  });

  const load = () => import('./subscription-switch');

  it('keeps a sign-in across a restart', async () => {
    const before = await load();
    await before.setSubscription('codex', true);
    expect(before.usesSubscription('codex')).toBe(true);

    vi.resetModules();
    const after = await load();
    expect(after.usesSubscription('codex')).toBe(false);
    await after.loadSubscriptionSwitches();
    expect(after.usesSubscription('codex')).toBe(true);
    expect(after.usesSubscription('claude-code')).toBe(false);
  });

  it('turns off on sign-out', async () => {
    const sw = await load();
    await sw.setSubscription('claude-code', true);
    await sw.setSubscription('claude-code', false);
    expect(sw.usesSubscription('claude-code')).toBe(false);
    expect(state.size).toBe(0);
  });

  it('stays on while the deployment environment holds it on', async () => {
    config.claudeCodeSubscription = true;
    const sw = await load();
    await sw.setSubscription('claude-code', false);
    expect(sw.usesSubscription('claude-code')).toBe(true);
  });

  it('stays off and lets the runtime boot when the switch cannot be read', async () => {
    vi.mocked(runtimeStateService.get).mockRejectedValueOnce(new Error('database locked'));
    const sw = await load();
    await expect(sw.loadSubscriptionSwitches()).resolves.toBeUndefined();
    expect(sw.usesSubscription('claude-code')).toBe(false);
  });
});
