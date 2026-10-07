import { Link } from '@tanstack/react-router';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { FieldDescription, FieldError, FieldLegend, FieldSet } from '@/components/ui/field';
import { useSlackChannels } from '@/hooks/use-slack-channels';

interface WebhookSlackChannelsFieldProps {
  value: string[];
  onChange: (ids: string[]) => void;
  error?: string;
}

/**
 * The linked Slack channels a Slack delivery posts to. A chosen channel that
 * was unlinked since stays listed, so the user can see it and clear it.
 */
export function WebhookSlackChannelsField({ value, onChange, error }: WebhookSlackChannelsFieldProps) {
  const { data, isPending } = useSlackChannels();
  const linked = data?.channels ?? [];
  const options = [
    ...linked.map((c) => ({ id: c.channelId, label: `#${c.channelName ?? c.channelId}`, isMain: c.isMain, isLinked: true })),
    ...value
      .filter((id) => !linked.some((c) => c.channelId === id))
      .map((id) => ({ id, label: id, isMain: false, isLinked: false })),
  ];

  const toggle = (id: string, checked: boolean) =>
    onChange(checked ? [...value, id] : value.filter((v) => v !== id));

  return (
    <FieldSet data-invalid={Boolean(error)}>
      <FieldLegend variant="label">Slack channels</FieldLegend>
      {isPending ? (
        <FieldDescription>Loading channels…</FieldDescription>
      ) : options.length === 0 ? (
        <FieldDescription>
          No Slack channel is linked. Link one on the <Link to="/channels">Channels</Link> page to
          choose it here.
        </FieldDescription>
      ) : (
        <>
          <div className="flex flex-col gap-2">
            {options.map((option) => (
              <div key={option.id} className="flex items-center gap-2 text-sm">
                <label className="flex items-center gap-2">
                  <Checkbox
                    checked={value.includes(option.id)}
                    onCheckedChange={(checked: boolean) => toggle(option.id, checked)}
                  />
                  <span className={option.isLinked ? undefined : 'font-mono text-muted-foreground'}>
                    {option.label}
                  </span>
                </label>
                {option.isMain && <Badge variant="outline">Main</Badge>}
                {!option.isLinked && <span className="text-xs text-muted-foreground">not linked</span>}
              </div>
            ))}
          </div>
          {error ? (
            <FieldError>{error}</FieldError>
          ) : (
            <FieldDescription>
              Leave all unchecked to post to your Slack DM, or to the main channel when no DM is linked.
            </FieldDescription>
          )}
        </>
      )}
    </FieldSet>
  );
}
