// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '@testing-library/jest-dom/vitest';
import type { ModelSelectionInfo } from '@/types';

const { api } = vi.hoisted(() => ({
  api: {
    getModelSelection: vi.fn(),
    updateModelSelection: vi.fn(),
    getModel: vi.fn(),
    getHeartbeatModel: vi.fn(),
    getCronModel: vi.fn(),
  },
}));
vi.mock('@/api/runtime-client', () => ({ runtimeApi: api }));
vi.mock('@/lib/agent-context', () => ({ useAgent: () => ({ agentId: 'agent-1' }) }));

import { ModelSelectionFields } from './model-selection-fields';

function selection(
  mode: 'fixed' | 'auto',
  tiers: Partial<Record<'small' | 'medium' | 'large', string>> = {},
): ModelSelectionInfo {
  const tier = (value?: string) => ({ override: value ?? null, effective: value ?? null });
  return {
    mode: { override: mode, effective: mode },
    tiers: { small: tier(tiers.small), medium: tier(tiers.medium), large: tier(tiers.large) },
  };
}

function renderFields() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModelSelectionFields />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getModel.mockResolvedValue({ model: 'main-model' });
  api.getHeartbeatModel.mockResolvedValue({ model: null, effective: 'main-model' });
  api.getCronModel.mockResolvedValue({ model: null, effective: 'main-model' });
});

describe('ModelSelectionFields', () => {
  it('shows the fixed model fields in Fixed mode', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    renderFields();

    expect(await screen.findByText('Scheduled-task model')).toBeInTheDocument();
    expect(screen.queryByText('Small model')).not.toBeInTheDocument();
  });

  it('shows the three tiers in Auto mode', async () => {
    api.getModelSelection.mockResolvedValue(selection('auto', { small: 's', large: 'l' }));
    renderFields();

    expect(await screen.findByText('Small model')).toBeInTheDocument();
    expect(screen.getByText('Medium model')).toBeInTheDocument();
    expect(screen.getByText('Large model')).toBeInTheDocument();
    expect(screen.queryByText('Heartbeat model')).not.toBeInTheDocument();
  });

  it('switches straight to Auto when small and large are set', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed', { small: 's', large: 'l' }));
    api.updateModelSelection.mockResolvedValue(selection('auto', { small: 's', large: 'l' }));
    renderFields();

    const toggle = await screen.findByRole('switch', { name: 'Auto model selection' });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    toggle.click();

    await waitFor(() => expect(api.updateModelSelection).toHaveBeenCalledWith({ mode: 'auto' }));
  });

  it('asks for the missing tiers before switching to Auto', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    renderFields();

    const toggle = await screen.findByRole('switch', { name: 'Auto model selection' });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    toggle.click();

    expect(await screen.findByText('Set a small and a large model to turn Auto on.')).toBeInTheDocument();
    expect(screen.getByText('Small model')).toBeInTheDocument();
    expect(api.updateModelSelection).not.toHaveBeenCalled();
  });

  it('switches to Auto once the last required tier is saved', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed', { small: 's' }));
    api.updateModelSelection.mockImplementation(async (patch: Record<string, unknown>) =>
      'mode' in patch ? selection('auto', { small: 's', large: 'l' }) : selection('fixed', { small: 's', large: 'l' }),
    );
    renderFields();

    const toggle = await screen.findByRole('switch', { name: 'Auto model selection' });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    toggle.click();
    const edit = await screen.findByRole('button', { name: 'Edit large model' });
    await waitFor(() => expect(edit).toBeEnabled());
    edit.click();
    const input = await screen.findByRole('textbox', { name: 'Large model ID' });
    fireEvent.change(input, { target: { value: 'l' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(api.updateModelSelection).toHaveBeenCalledWith({ mode: 'auto' }));
    expect(api.updateModelSelection).toHaveBeenCalledTimes(2);
  });

  it('sends one switch request when it fails, and shows the error', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed', { small: 's' }));
    api.updateModelSelection.mockImplementation(async (patch: Record<string, unknown>) => {
      if ('mode' in patch) throw new Error('Runtime unavailable');
      return selection('fixed', { small: 's', large: 'l' });
    });
    renderFields();

    const toggle = await screen.findByRole('switch', { name: 'Auto model selection' });
    await waitFor(() => expect(toggle).not.toHaveAttribute('data-disabled'));
    toggle.click();
    const edit = await screen.findByRole('button', { name: 'Edit large model' });
    await waitFor(() => expect(edit).toBeEnabled());
    edit.click();
    const input = await screen.findByRole('textbox', { name: 'Large model ID' });
    fireEvent.change(input, { target: { value: 'l' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(await screen.findByText('Runtime unavailable')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(api.updateModelSelection.mock.calls.filter(([p]) => 'mode' in p)).toHaveLength(1);
  });
});
