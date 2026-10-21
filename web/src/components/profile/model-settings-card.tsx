import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import type { ModelSelectionInfo, ModelSelectionPatch, ModelTier } from '@/types';
import { TIER_ROWS } from '@/lib/model-tiers';
import { AutoSetupForm } from './auto-setup-form';
import { ModelField } from './model-field';
import { ModeSwitch, type ModelMode as Mode } from './mode-switch';

const SELECTION_KEY = 'agent-model-selection';

const MODE_SUMMARY: Record<Mode, string> = {
  fixed: 'Every turn runs on the same model. Heartbeats and scheduled tasks can use their own.',
  auto: 'Each turn runs on the smallest model below that suits the request.',
};

/**
 * The agent's model settings. Fixed mode shows one model each for chat,
 * heartbeats and scheduled tasks; Auto mode shows the small, medium and large
 * models the agent chooses between for each turn. Choosing Auto before a small
 * and a large model are set shows a form for them, and its Save turns Auto on.
 */
export function ModelSettingsCard() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  // Auto chosen but not saved yet: the models typed so far live in the form.
  const [settingUp, setSettingUp] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: selection } = useQuery({
    queryKey: [SELECTION_KEY, agent.agentId],
    queryFn: () => runtimeApi.getModelSelection(),
  });

  const selectionMut = useMutation({
    mutationFn: (patch: ModelSelectionPatch) => runtimeApi.updateModelSelection(patch),
    onSuccess: (data) => {
      queryClient.setQueryData([SELECTION_KEY, agent.agentId], data);
      // The tier rows read their own queries; the next render reloads them.
      for (const { tier } of TIER_ROWS) {
        queryClient.removeQueries({ queryKey: [`agent-model-tier-${tier}`, agent.agentId] });
      }
      setSettingUp(false);
      setError(null);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Update failed'),
  });

  const isAuto = selection?.mode.effective === 'auto';
  const shown: Mode = isAuto || settingUp ? 'auto' : 'fixed';

  const loadSelection = () =>
    queryClient.ensureQueryData({
      queryKey: [SELECTION_KEY, agent.agentId],
      queryFn: () => runtimeApi.getModelSelection(),
    });

  const saveTier = async (tier: ModelTier, model: string | null) => {
    const saved = await runtimeApi.updateModelSelection({ [tier]: model });
    queryClient.setQueryData([SELECTION_KEY, agent.agentId], saved);
    return tierInfo(saved, tier);
  };

  const choose = (mode: Mode) => {
    setError(null);
    if (mode === 'fixed') {
      setSettingUp(false);
      if (isAuto) selectionMut.mutate({ mode: 'fixed' });
      return;
    }
    if (isAuto || settingUp || !selection) return;
    if (missingTiers(selection).length > 0) setSettingUp(true);
    else selectionMut.mutate({ mode: 'auto' });
  };

  const tierRows = TIER_ROWS.map(({ tier, label, description, required }) => (
    <ModelField
      key={tier}
      label={label}
      description={description}
      tag={required ? undefined : { text: 'Optional', tone: 'muted' }}
      queryKey={`agent-model-tier-${tier}`}
      load={() => loadSelection().then((s) => tierInfo(s, tier))}
      save={(model) => saveTier(tier, model)}
      allowEmpty={!required}
      fallbackLabel={(model) => `${model} (deployment default)`}
    />
  ));

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
        <CardDescription>{MODE_SUMMARY[shown]}</CardDescription>
        <CardAction>
          <ModeSwitch value={shown} onChange={choose} busy={!selection || selectionMut.isPending} />
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-3">
        {settingUp && selection ? (
          <AutoSetupForm
            initial={{
              small: selection.tiers.small.override ?? '',
              medium: selection.tiers.medium.override ?? '',
              large: selection.tiers.large.override ?? '',
            }}
            deploymentDefaults={{
              small: selection.tiers.small.override ? null : selection.tiers.small.effective,
              medium: selection.tiers.medium.override ? null : selection.tiers.medium.effective,
              large: selection.tiers.large.override ? null : selection.tiers.large.effective,
            }}
            saving={selectionMut.isPending}
            error={error}
            onSave={(patch) => selectionMut.mutate(patch)}
            onCancel={() => {
              setSettingUp(false);
              setError(null);
            }}
          />
        ) : (
          <>
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="divide-y divide-border">{isAuto ? tierRows : fixedRows}</div>
          </>
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
