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
  for (const mode of ['chat', 'goal', 'cron', 'heartbeat', 'webhook'])
    expect(hasComputerForMode(mode)).toBe(true);
  for (const mode of ['meeting', 'subagent']) expect(hasComputerForMode(mode)).toBe(false);
});
