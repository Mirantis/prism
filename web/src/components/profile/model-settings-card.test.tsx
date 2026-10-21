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

import { ModelSettingsCard } from './model-settings-card';

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

function renderCard() {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false }, queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ModelSettingsCard />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getModel.mockResolvedValue({ model: 'main-model' });
  api.getHeartbeatModel.mockResolvedValue({ model: null, effective: 'main-model' });
  api.getCronModel.mockResolvedValue({ model: null, effective: 'main-model' });
});

describe('ModelSettingsCard', () => {
  it('shows the fixed model fields in Fixed mode', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    renderCard();

    expect(await screen.findByText('Scheduled tasks')).toBeInTheDocument();
    expect(screen.queryByText('Small', { exact: true })).not.toBeInTheDocument();
  });

  it('shows the three tiers in Auto mode', async () => {
    api.getModelSelection.mockResolvedValue(selection('auto', { small: 's', large: 'l' }));
    renderCard();

    expect(await screen.findByText('Small', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Medium', { exact: true })).toBeInTheDocument();
    expect(screen.getByText('Large', { exact: true })).toBeInTheDocument();
    expect(screen.queryByText('Heartbeats')).not.toBeInTheDocument();
  });

  it('switches straight to Auto when small and large are set', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed', { small: 's', large: 'l' }));
    api.updateModelSelection.mockResolvedValue(selection('auto', { small: 's', large: 'l' }));
    renderCard();

    const toggle = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(toggle).toBeEnabled());
    toggle.click();

    await waitFor(() => expect(api.updateModelSelection).toHaveBeenCalledWith({ mode: 'auto' }));
  });

  it('switches to Auto with a form for the missing models, storing nothing yet', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    renderCard();

    const auto = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(auto).toBeEnabled());
    auto.click();

    expect(await screen.findByRole('form', { name: 'Auto models' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Auto' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('Not saved. The agent keeps using its fixed models until you save.')).toBeInTheDocument();
    expect(screen.queryByText('Heartbeats')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save and turn on Auto' })).toBeDisabled();
    expect(api.updateModelSelection).not.toHaveBeenCalled();
  });

  it('saves the models and the mode in one request', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    api.updateModelSelection.mockResolvedValue(selection('auto', { small: 's', large: 'l' }));
    renderCard();

    const auto = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(auto).toBeEnabled());
    auto.click();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Small model ID' }), { target: { value: 's' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Large model ID' }), { target: { value: 'l' } });
    screen.getByRole('button', { name: 'Save and turn on Auto' }).click();

    await waitFor(() =>
      expect(api.updateModelSelection).toHaveBeenCalledWith({ mode: 'auto', small: 's', medium: null, large: 'l' }),
    );
    expect(api.updateModelSelection).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('form', { name: 'Auto models' })).not.toBeInTheDocument());
  });

  it('goes back to the fixed models on Cancel', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    renderCard();

    const auto = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(auto).toBeEnabled());
    auto.click();
    (await screen.findByRole('button', { name: 'Cancel' })).click();

    expect(await screen.findByText('Heartbeats')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Fixed' })).toHaveAttribute('aria-checked', 'true');
    expect(api.updateModelSelection).not.toHaveBeenCalled();
  });

  it('keeps the form and shows the error when the save fails', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    api.updateModelSelection.mockRejectedValue(new Error('Runtime unavailable'));
    renderCard();

    const auto = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(auto).toBeEnabled());
    auto.click();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Small model ID' }), { target: { value: 's' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Large model ID' }), { target: { value: 'l' } });
    screen.getByRole('button', { name: 'Save and turn on Auto' }).click();

    expect(await screen.findByText('Runtime unavailable')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Auto models' })).toBeInTheDocument();
    expect(api.updateModelSelection).toHaveBeenCalledTimes(1);
  });

  it('keeps a deployment model for a tier left empty, and does not require it', async () => {
    const fromDeployment = selection('fixed');
    fromDeployment.tiers.small = { override: null, effective: 'deploy-small' };
    api.getModelSelection.mockResolvedValue(fromDeployment);
    api.updateModelSelection.mockResolvedValue(selection('auto', { small: 'deploy-small', large: 'l' }));
    renderCard();

    const auto = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(auto).toBeEnabled());
    auto.click();
    const small = await screen.findByRole('textbox', { name: 'Small model ID' });
    expect(small).toHaveAttribute('placeholder', 'deploy-small (deployment default)');
    fireEvent.change(screen.getByRole('textbox', { name: 'Large model ID' }), { target: { value: 'l' } });
    screen.getByRole('button', { name: 'Save and turn on Auto' }).click();

    await waitFor(() =>
      expect(api.updateModelSelection).toHaveBeenCalledWith({ mode: 'auto', small: null, medium: null, large: 'l' }),
    );
  });

  it('cannot be cancelled while the save is in flight', async () => {
    api.getModelSelection.mockResolvedValue(selection('fixed'));
    api.updateModelSelection.mockReturnValue(new Promise(() => {}));
    renderCard();

    const auto = await screen.findByRole('radio', { name: 'Auto' });
    await waitFor(() => expect(auto).toBeEnabled());
    auto.click();
    fireEvent.change(await screen.findByRole('textbox', { name: 'Small model ID' }), { target: { value: 's' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Large model ID' }), { target: { value: 'l' } });
    screen.getByRole('button', { name: 'Save and turn on Auto' }).click();

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled());
  });
});
