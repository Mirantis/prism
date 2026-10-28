import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { runtimeApi } from '@/api/runtime-client';
import { DeliverToField } from '@/components/shared/deliver-to-field';
import { SlackChannelsField } from '@/components/shared/slack-channels-field';
import { FieldDescription, FieldError } from '@/components/ui/field';
import type { HeartbeatDelivery } from '@/types';

/** Where a heartbeat run may post. Each change is saved at once and applies from the next run. */
export function HeartbeatDeliveryField({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const queryKey = ['heartbeat-delivery', agentId];
  const { data } = useQuery({ queryKey, queryFn: () => runtimeApi.heartbeatDelivery() });

  const updateMut = useMutation({
    mutationFn: (changes: Partial<HeartbeatDelivery>) => runtimeApi.updateHeartbeatDelivery(changes),
    onSuccess: (saved) => queryClient.setQueryData(queryKey, saved),
  });

  if (!data) return null;

  return (
    <div className="max-w-sm space-y-2">
      <DeliverToField
        id="heartbeat-deliver-to"
        value={data.deliverTo}
        onChange={(deliverTo) => updateMut.mutate({ deliverTo })}
      />
      {data.deliverTo === 'none' && <FieldDescription>Heartbeat checks run and post no message.</FieldDescription>}
      {data.deliverTo === 'slack' && (
        // Each check builds on the saved list, so the next one waits for the save.
        <SlackChannelsField
          value={data.channelIds}
          onChange={(channelIds) => updateMut.mutate({ channelIds })}
          disabled={updateMut.isPending}
        />
      )}
      {updateMut.error && (
        <FieldError>{updateMut.error instanceof Error ? updateMut.error.message : 'Update failed'}</FieldError>
      )}
    </div>
  );
}
