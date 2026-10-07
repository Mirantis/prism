import { useState } from 'react';
import { webhookOrigin as getWebhookOrigin } from '@/components/webhooks/webhook-endpoint';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FieldError } from '@/components/ui/field';
import { Pencil, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { SectionHeader } from '@/components/layout/section-header';
import { CopyButton } from '@/components/shared/copy-button';
import { EmptyState } from '@/components/shared/empty-state';
import { IconTile } from '@/components/shared/icon-tile';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useSlackChannels } from '@/hooks/use-slack-channels';
import { useFormErrors } from '@/hooks/use-form-errors';
import { CreateModal } from '@/components/shared/create-modal';
import { DeleteConfirm } from '@/components/shared/delete-confirm';
import { WebhookAuthBadge } from '@/components/webhooks/webhook-auth-badge';
import { WebhookSubscriptionCard } from '@/components/webhooks/webhook-subscription-card';
import { WebhookEditDialog } from '@/components/webhooks/webhook-edit-dialog';
import { isWebhookAuthComplete } from '@/components/webhooks/webhook-auth-fields';
import { WebhookSubscriptionFields } from '@/components/webhooks/webhook-subscription-fields';
import {
  DELIVER_LABELS,
  EMPTY_WEBHOOK_SUBSCRIPTION_FORM,
  slackChannelNames,
  slackChannelsToSave,
  type WebhookSubscriptionFormValues,
} from '@/components/webhooks/webhook-subscription-form';
import type { WebhookSubscription } from '@/types';

export const Route = createFileRoute('/webhooks')({
  component: WebhooksPage,
});

function WebhooksPage() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [editTarget, setEditTarget] = useState<WebhookSubscription | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState(EMPTY_WEBHOOK_SUBSCRIPTION_FORM);
  const { fieldErrors, clearFieldError, handleError, reset: resetErrors } = useFormErrors();

  const { data: receiver, isLoading: receiverLoading } = useQuery({
    queryKey: ['webhook-receiver', agent.agentId],
    queryFn: () => runtimeApi.getWebhookReceiver(),
  });

  const { data: subscriptions, isLoading: subsLoading } = useQuery({
    queryKey: ['webhook-subscriptions', agent.agentId],
    queryFn: () => runtimeApi.listWebhookSubscriptions(),
  });

  // Names the Slack channels each subscription posts to.
  const { data: slackChannels } = useSlackChannels();
  const channelNames = (s: WebhookSubscription) => slackChannelNames(s.slackChannelIds, slackChannels?.channels ?? []);

  const receiverMut = useMutation({
    mutationFn: (enabled: boolean) => runtimeApi.setWebhookReceiver(enabled),
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: ['webhook-receiver', agent.agentId] });
    },
  });

  const createMut = useMutation({
    mutationFn: (input: WebhookSubscriptionFormValues) =>
      runtimeApi.createWebhookSubscription({
        name: input.name.trim(),
        description: input.description.trim() || undefined,
        events: input.events.trim() || undefined,
        prompt: input.prompt.trim() || undefined,
        deliverTo: input.deliverTo,
        slackChannelIds: slackChannelsToSave(input),
        deliverOnly: input.deliverOnly,
        ...(input.authType !== 'none'
          ? {
              authType: input.authType,
              authHeader: input.authHeader.trim(),
              authPrefix: input.authPrefix || undefined,
              authAlgorithm: input.authAlgorithm,
              authEncoding: input.authEncoding,
              authSignedUrl: input.authSignedUrl.trim() || undefined,
              secret: input.secret,
            }
          : { authType: 'none' }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions', agent.agentId] });
      resetModal();
    },
  });

  const toggleMut = useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }) =>
      runtimeApi.updateWebhookSubscription(id, { isActive }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions', agent.agentId] });
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => runtimeApi.deleteWebhookSubscription(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-subscriptions', agent.agentId] });
      setDeleteTarget(null);
    },
  });

  const setField = <K extends keyof WebhookSubscriptionFormValues>(
    key: K,
    value: WebhookSubscriptionFormValues[K],
  ) => {
    setForm((f) => ({ ...f, [key]: value }));
    clearFieldError(key);
  };

  const resetModal = () => {
    setIsCreating(false);
    setForm(EMPTY_WEBHOOK_SUBSCRIPTION_FORM);
    resetErrors();
  };

  const handleCreate = async () => {
    try {
      await createMut.mutateAsync(form);
    } catch (e) {
      handleError(e);
    }
  };

  if (receiverLoading || subsLoading) {
    return (
      <Page>
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-96" />
        </div>
        <Skeleton className="h-64" />
      </Page>
    );
  }

  const enabled = receiver?.enabled === true;
  const webhookOrigin = getWebhookOrigin(receiver, window.location);
  const endpointUrl = (name: string) => webhookOrigin ? `${webhookOrigin}/agents/webhooks/${name}` : null;

  return (
    <Page>
      <PageHeader
        title="Webhooks"
        description="Let external systems (Alertmanager, PagerDuty, GitHub, …) trigger the agent over HTTP."
        actions={
          enabled && (
            <Button onClick={() => setIsCreating(true)}>
              <Plus />
              New subscription
            </Button>
          )
        }
      />

      <Card className="gap-3 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex min-w-0 items-start gap-3">
            <IconTile icon={WebhookIcon} tone={enabled ? 'success' : 'neutral'} size="md" />
            <div className="space-y-1">
              <label htmlFor="webhook-receiver" className="font-medium text-strong">
                Webhook receiver
              </label>
              <p id="webhook-receiver-description" className="text-sm text-muted-foreground">
                {enabled
                  ? 'Accepting events for active subscriptions.'
                  : 'Enable to accept events from external systems.'}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm text-muted-foreground">
              {receiverMut.isPending ? 'Updating…' : enabled ? 'Enabled' : 'Disabled'}
            </span>
            <Switch
              id="webhook-receiver"
              checked={enabled}
              onCheckedChange={(checked: boolean) => receiverMut.mutate(checked)}
              disabled={receiverMut.isPending}
              aria-label="Webhook receiver"
              aria-describedby="webhook-receiver-description"
            />
          </div>
        </div>
        {receiverMut.isError && <FieldError>{receiverMut.error.message}</FieldError>}
      </Card>

      <section className="@container space-y-3">
        <SectionHeader
          title={`Subscriptions (${subscriptions?.length ?? 0})`}
          description={enabled ? (
            webhookOrigin ? (
              <>
                Send events to <code className="break-all">{webhookOrigin}</code> using the endpoint for each subscription.
              </>
            ) : `Use your public ingress or tunnel URL with the endpoint paths below. The receiver listens on port ${receiver?.port}.`
          ) : subscriptions?.length ? 'Enable the receiver to resume deliveries. Subscription settings are saved.' : undefined}
        />

        {subscriptions && subscriptions.length > 0 ? (
          <>
            <div className="grid gap-3 @min-[640px]:grid-cols-2 @min-[1000px]:hidden">
              {subscriptions.map((s) => (
                <WebhookSubscriptionCard
                  key={s.id}
                  subscription={s}
                  endpoint={endpointUrl(s.name)}
                  deliveryLabel={[DELIVER_LABELS[s.deliverTo], channelNames(s)].filter(Boolean).join(': ')}
                  isUpdating={toggleMut.isPending && toggleMut.variables?.id === s.id}
                  onToggle={(isActive) => toggleMut.mutate({ id: s.id, isActive })}
                  onEdit={() => setEditTarget(s)}
                  onDelete={() => setDeleteTarget({ id: s.id, name: s.name })}
                />
              ))}
            </div>
            <Card className="hidden py-0 @min-[1000px]:block">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead className="pl-4">Name</TableHead>
                    <TableHead className="hidden md:table-cell">Events</TableHead>
                    <TableHead>Delivery</TableHead>
                    <TableHead>Endpoint</TableHead>
                    <TableHead className="hidden md:table-cell">Auth</TableHead>
                    <TableHead className="w-[60px]">Active</TableHead>
                    <TableHead className="w-[90px]" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="pl-4">
                        <div className="flex items-center gap-3">
                          <IconTile icon={WebhookIcon} tone={s.isActive ? 'success' : 'neutral'} />
                          <div className="min-w-0">
                            <span className="block max-w-48 truncate font-medium text-strong" title={s.name}>{s.name}</span>
                            {s.description && (
                              <p className="max-w-48 truncate text-xs text-muted-foreground" title={s.description}>{s.description}</p>
                            )}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                        {s.events ? <code className="block max-w-24 truncate font-mono text-xs" title={s.events}>{s.events}</code> : 'all'}
                      </TableCell>
                      <TableCell className="text-sm">
                        {DELIVER_LABELS[s.deliverTo]}
                        {s.slackChannelIds.length > 0 && (
                          <span className="block max-w-44 truncate text-xs text-muted-foreground" title={channelNames(s)}>
                            {channelNames(s)}
                          </span>
                        )}
                        {s.deliverOnly && <span className="block text-xs text-muted-foreground">direct — no agent</span>}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <code className="max-w-[180px] truncate font-mono text-xs" title={endpointUrl(s.name) ?? undefined}>/agents/webhooks/{s.name}</code>
                          {webhookOrigin && <CopyButton text={endpointUrl(s.name)!} label="Copy endpoint URL" />}
                        </div>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                        <WebhookAuthBadge authType={s.authType} />
                        {s.authHeader && s.authType !== 'none' && (
                          <span className="mt-1 block max-w-44 truncate font-mono text-xs" title={s.authHeader}>{s.authHeader}</span>
                        )}
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={s.isActive}
                          disabled={toggleMut.isPending && toggleMut.variables?.id === s.id}
                          onCheckedChange={(checked: boolean) =>
                            toggleMut.mutate({ id: s.id, isActive: checked })
                          }
                          aria-label={`Toggle ${s.name}`}
                        />
                      </TableCell>
                      <TableCell>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Edit"
                          aria-label={`Edit ${s.name}`}
                          className="text-muted-foreground"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setEditTarget(s);
                          }}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${s.name}`}
                          className="text-muted-foreground hover:text-destructive"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setDeleteTarget({ id: s.id, name: s.name });
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          </>
        ) : (
          <Card>
            <EmptyState
              icon={WebhookIcon}
              title="No webhooks configured"
              description={enabled
                ? 'Create a subscription to give an external system its own endpoint.'
                : 'Enable the receiver, then create your first subscription.'}
            />
          </Card>
        )}
      </section>

      <CreateModal
        isOpen={isCreating}
        onClose={resetModal}
        title="New subscription"
        onSubmit={handleCreate}
        isSubmitting={createMut.isPending}
        submitLabel="Create"
        // A chosen scheme without its header + secret can't be created (the
        // runtime would 400), so keep Create disabled until they're filled in.
        submitDisabled={!form.name.trim() || !isWebhookAuthComplete(form)}
      >
        <WebhookSubscriptionFields
          mode="create"
          values={form}
          onChange={setField}
          fieldErrors={fieldErrors}
        />
      </CreateModal>

      {editTarget && (
        <WebhookEditDialog subscription={editTarget} onClose={() => setEditTarget(null)} />
      )}

      {deleteTarget && (
        <DeleteConfirm
          isOpen
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMut.mutate(deleteTarget.id)}
          isDeleting={deleteMut.isPending}
          entityType="webhook subscription"
          entityName={deleteTarget.name}
        />
      )}
    </Page>
  );
}
