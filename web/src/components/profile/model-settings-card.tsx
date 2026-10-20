import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { ModelSelectionInfo, ModelTier } from '@/types';
import { ModelField } from './model-field';
import { ModeSwitch, type ModelMode as Mode } from './mode-switch';

const SELECTION_KEY = 'agent-model-selection';

const MODE_SUMMARY: Record<Mode, string> = {
  fixed: 'Every turn runs on the same model. Heartbeats and scheduled tasks can use their own.',
  auto: 'Each turn runs on the smallest model below that suits the request.',
};

const TIER_ROWS: { tier: ModelTier; label: string; description: string; required: boolean }[] = [
  { tier: 'small', label: 'Small', description: 'Quick answers, lookups and simple changes.', required: true },
  { tier: 'medium', label: 'Medium', description: 'Moderate work on one topic. Leave empty to use small and large only.', required: false },
  { tier: 'large', label: 'Large', description: 'Multi-step work, code, planning, and anything unclear.', required: true },
];

/**
 * The agent's model settings. Fixed mode shows one model each for chat,
 * heartbeats and scheduled tasks; Auto mode shows the small, medium and large
 * models the agent chooses between for each turn. The switch shows the stored
 * mode: choosing Auto before a small and a large model are set opens their
 * fields below the fixed ones, and the save that completes them switches.
 */
export function ModelSettingsCard() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [pendingAuto, setPendingAutoState] = useState(false);
  // Read after a tier save resolves, so it has to see a mode changed back meanwhile.
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
    mutationFn: (mode: Mode) => runtimeApi.updateModelSelection({ mode }),
    onSuccess: (data) => {
      queryClient.setQueryData([SELECTION_KEY, agent.agentId], data);
      setPendingAuto(false);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Update failed'),
  });

  const missing = selection ? missingTiers(selection) : [];
  const isAuto = selection?.mode.effective === 'auto';
  const stored: Mode = isAuto ? 'auto' : 'fixed';

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

  const choose = (mode: Mode) => {
    setError(null);
    if (mode === 'fixed') {
      setPendingAuto(false);
      if (isAuto) modeMut.mutate('fixed');
      return;
    }
    if (isAuto) return;
    if (missing.length > 0) setPendingAuto(true);
    else modeMut.mutate('auto');
  };

  const tierRows = TIER_ROWS.map(({ tier, label, description, required }) => {
    const unset = !selection?.tiers[tier].effective;
    return (
      <ModelField
        key={tier}
        label={label}
        description={description}
        tag={
          required
            ? unset
              ? { text: 'Required', tone: 'attention' }
              : undefined
            : { text: 'Optional', tone: 'muted' }
        }
        queryKey={`agent-model-tier-${tier}`}
        load={() => loadSelection().then((s) => tierInfo(s, tier))}
        save={(model) => saveTier(tier, model)}
        allowEmpty
        fallbackLabel={(model) => `${model} (deployment default)`}
      />
    );
  });

  const fixedRows = (
    <>
      <ModelField
        label="Chat"
        description="Conversations and everything not listed below."
        queryKey="agent-model"
        load={() => runtimeApi.getModel()}
        save={(m) => runtimeApi.updateModel(m)}
        affects={['agent-heartbeat-model', 'agent-cron-model']}
      />
      <ModelField
        label="Heartbeats"
        description="The periodic check of the agent's heartbeat list."
        queryKey="agent-heartbeat-model"
        load={() => runtimeApi.getHeartbeatModel()}
        save={(m) => runtimeApi.updateHeartbeatModel(m)}
        allowEmpty
        fallbackLabel={() => 'Same as chat'}
      />
      <ModelField
        label="Scheduled tasks"
        description="Runs started by a schedule."
        queryKey="agent-cron-model"
        load={() => runtimeApi.getCronModel()}
        save={(m) => runtimeApi.updateCronModel(m)}
        allowEmpty
        fallbackLabel={() => 'Same as chat'}
      />
    </>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Models</CardTitle>
        <CardDescription>{MODE_SUMMARY[stored]}</CardDescription>
        <CardAction>
          <ModeSwitch value={stored} onChange={choose} busy={!selection || modeMut.isPending} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="divide-y divide-border">{isAuto ? tierRows : fixedRows}</div>
        {pendingAuto && !isAuto && (
          <section aria-label="Set up Auto" className="space-y-2 rounded-xl p-3.5 ring-1 ring-border ring-inset">
            <div className="flex items-start justify-between gap-3">
              <div role="status" className="flex items-start gap-2 text-sm text-amber-700 dark:text-amber-300">
                <Info className="mt-0.5 size-4 shrink-0" />
                <span>
                  To turn on Auto, add a {missing.join(' and a ')} model. Until then the agent
                  keeps using the fixed models above.
                </span>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setPendingAuto(false)}>
                Cancel
              </Button>
            </div>
            <div className="divide-y divide-border">{tierRows}</div>
          </section>
        )}
      </CardContent>
    </Card>
  );
}

function tierInfo(selection: ModelSelectionInfo, tier: ModelTier) {
  const { override, effective } = selection.tiers[tier];
  return { model: override, effective: effective ?? undefined };
}

function missingTiers(selection: ModelSelectionInfo): ModelTier[] {
  return (['small', 'large'] as const).filter((tier) => !selection.tiers[tier].effective);
}
