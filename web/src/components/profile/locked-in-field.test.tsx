// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { AgentDetails } from '@/types';

const { mockUpdateLockedIn } = vi.hoisted(() => ({ mockUpdateLockedIn: vi.fn() }));
vi.mock('@/api/runtime-client', () => ({
  runtimeApi: { updateLockedIn: mockUpdateLockedIn },
}));
vi.mock('@/lib/agent-context', () => ({
  useAgent: () => ({ agentId: 'agent-1' }),
}));

import { LockedInField } from './locked-in-field';

afterEach(cleanup);

function details(overrides: Partial<AgentDetails> = {}): AgentDetails {
  return { lockedIn: false, verbose: false, ...overrides } as AgentDetails;
}

function renderField(d: AgentDetails) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LockedInField details={d} />
    </QueryClientProvider>,
  );
}

describe('LockedInField', () => {
  it('reads out the unlocked state', () => {
    renderField(details({ lockedIn: false }));
    const toggle = screen.getByRole('switch', { name: 'Locked-in mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('Unlocked')).toBeInTheDocument();
  });

  it('reads out the locked state', () => {
    renderField(details({ lockedIn: true }));
    const toggle = screen.getByRole('switch', { name: 'Locked-in mode' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Locked')).toBeInTheDocument();
  });

  it('says the lock is a drift guardrail rather than a security boundary', () => {
    // The shell bypass is deliberately open in v1, so the UI must not let a user
    // read the switch as containment.
    renderField(details());
    expect(screen.getByText(/not a security boundary/i)).toBeInTheDocument();
  });

  it('PATCHes the new value when toggled on', async () => {
    mockUpdateLockedIn.mockResolvedValue({ lockedIn: true });
    renderField(details({ lockedIn: false }));

    screen.getByRole('switch', { name: 'Locked-in mode' }).click();

    await waitFor(() => expect(mockUpdateLockedIn).toHaveBeenCalledWith(true));
  });

  it('PATCHes false when toggled back off', async () => {
    mockUpdateLockedIn.mockResolvedValue({ lockedIn: false });
    renderField(details({ lockedIn: true }));

    screen.getByRole('switch', { name: 'Locked-in mode' }).click();

    await waitFor(() => expect(mockUpdateLockedIn).toHaveBeenCalledWith(false));
  });

  it('surfaces a failed update instead of leaving the optimistic state', async () => {
    mockUpdateLockedIn.mockRejectedValue(new Error('runtime unreachable'));
    renderField(details({ lockedIn: false }));

    screen.getByRole('switch', { name: 'Locked-in mode' }).click();

    await waitFor(() => expect(screen.getByText('runtime unreachable')).toBeInTheDocument());
  });
});
