import { expect, it, vi } from 'vitest';
import { hasComputerForMode, initComputerAvailability } from '../supported';

vi.mock('../../../lib/has-binary', () => ({
  missingBinary: vi.fn(async () => null),
}));
vi.mock('../../meeting/browser-stack', () => ({
  isBrowserAvailable: vi.fn(async () => true),
}));

it('offers the desktop only to modes that can own it', async () => {
  await initComputerAvailability();
  for (const mode of ['chat', 'goal', 'cron', 'heartbeat', 'webhook', 'voice'])
    expect(hasComputerForMode(mode)).toBe(true);
  expect(hasComputerForMode('subagent')).toBe(false);
});
