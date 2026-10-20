import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Switch } from '@/components/ui/switch';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { ModelSelectionInfo, ModelTier } from '@/types';
import { ModelField } from './model-field';

const SELECTION_KEY = 'agent-model-selection';

const TIER_FIELDS: { tier: ModelTier; label: string; hint: string }[] = [
  { tier: 'small', label: 'Small model', hint: 'Required in Auto mode.' },
  { tier: 'medium', label: 'Medium model', hint: 'Optional. Leave empty to choose between small and large only.' },
  { tier: 'large', label: 'Large model', hint: 'Required in Auto mode.' },
];

/**
 * The agent's model settings. Fixed mode shows one model each for chat,
 * heartbeats and scheduled tasks; Auto mode shows the small, medium and large
 * models the agent chooses between for each turn. Turning Auto on before a
 * small and a large model are set shows their fields first, and the save that
 * completes them switches.
 */
export function ModelSelectionFields() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [pendingAuto, setPendingAutoState] = useState(false);
  // Read after a tier save resolves, so it has to see a switch flipped back meanwhile.
  const pendingAutoRef = useRef(false);
  const setPendingAuto = (value: boolean) => {
    pendingAutoRef.current = value;
    setPendingAutoState(value);
  };
  const [error, setError] = useState<string | null>(null);

  const { data: selection } = useQuery({
    queryKey: [SELECTION_KEY, agent.agentId],
    queryFn: () => runtimeApi.getModelSelection(),
  });

  const modeMut = useMutation({
    mutationFn: (mode: 'fixed' | 'auto') => runtimeApi.updateModelSelection({ mode }),
    onSuccess: (data) => {
      queryClient.setQueryData([SELECTION_KEY, agent.agentId], data);
      setPendingAuto(false);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Update failed'),
  });

  const missing = selection ? missingTiers(selection) : [];
  const isAuto = selection?.mode.effective === 'auto';

  const loadSelection = () =>
    queryClient.ensureQueryData({
      queryKey: [SELECTION_KEY, agent.agentId],
      queryFn: () => runtimeApi.getModelSelection(),
    });

  const saveTier = async (tier: ModelTier, model: string | null) => {
    const saved = await runtimeApi.updateModelSelection({ [tier]: model });
    queryClient.setQueryData([SELECTION_KEY, agent.agentId], saved);
    // The save that supplies the last required tier finishes the switch the user asked for.
    if (pendingAutoRef.current && saved.mode.effective !== 'auto' && missingTiers(saved).length === 0) {
      modeMut.mutate('auto');
    }
    return tierInfo(saved, tier);
  };

  const showTiers = isAuto || pendingAuto;

  const toggle = (auto: boolean) => {
    setError(null);
    if (!auto) {
      setPendingAuto(false);
      if (isAuto) modeMut.mutate('fixed');
      return;
    }
    if (missing.length > 0) setPendingAuto(true);
    else modeMut.mutate('auto');
  };

  return (
    <>
      <div className="flex flex-col gap-0.5">
        <span className="text-xs text-muted-foreground">Model selection</span>
        <div className="inline-flex items-center gap-2 text-sm">
          <Switch
            checked={showTiers}
            onCheckedChange={toggle}
            disabled={!selection || modeMut.isPending}
            aria-label="Auto model selection"
          />
          <span>{showTiers ? 'Auto' : 'Fixed'}</span>
        </div>
        {pendingAuto && missing.length > 0 && (
          <span className="text-xs text-muted-foreground">
            Set a {missing.join(' and a ')} model to turn Auto on.
          </span>
        )}
        {error && <span className="text-xs text-destructive">{error}</span>}
      </div>
      {showTiers
        ? TIER_FIELDS.map(({ tier, label, hint }) => (
            <ModelField
              key={tier}
              label={label}
              queryKey={`agent-model-tier-${tier}`}
              load={() => loadSelection().then((s) => tierInfo(s, tier))}
              save={(model) => saveTier(tier, model)}
              allowEmpty
              emptyHint={hint}
            />
          ))
        : (
          <>
            <ModelField
              label="Model"
              queryKey="agent-model"
              load={() => runtimeApi.getModel()}
              save={(m) => runtimeApi.updateModel(m)}
              affects={['agent-heartbeat-model', 'agent-cron-model']}
            />
            <ModelField
              label="Heartbeat model"
              queryKey="agent-heartbeat-model"
              load={() => runtimeApi.getHeartbeatModel()}
              save={(m) => runtimeApi.updateHeartbeatModel(m)}
              allowEmpty
            />
            <ModelField
              label="Scheduled-task model"
              queryKey="agent-cron-model"
              load={() => runtimeApi.getCronModel()}
              save={(m) => runtimeApi.updateCronModel(m)}
              allowEmpty
            />
          </>
        )}
    </>
  );
}

function tierInfo(selection: ModelSelectionInfo, tier: ModelTier) {
  const { override, effective } = selection.tiers[tier];
  return { model: override, effective: effective ?? undefined };
}

function missingTiers(selection: ModelSelectionInfo): ModelTier[] {
  return (['small', 'large'] as const).filter((tier) => !selection.tiers[tier].effective);
}
