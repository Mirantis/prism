import { useState } from 'react';
import { webhookOrigin as getWebhookOrigin } from '@/components/webhooks/webhook-endpoint';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
} from '@/components/ui/field';
import { KeyRound, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { SectionHeader } from '@/components/layout/section-header';
import { CopyButton } from '@/components/shared/copy-button';
import { EmptyState } from '@/components/shared/empty-state';
import { IconTile } from '@/components/shared/icon-tile';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useFormErrors } from '@/hooks/use-form-errors';
import { CreateModal } from '@/components/shared/create-modal';
import { DeleteConfirm } from '@/components/shared/delete-confirm';
import { WebhookAuthBadge } from '@/components/webhooks/webhook-auth-badge';
import { WebhookSubscriptionCard } from '@/components/webhooks/webhook-subscription-card';
import { WebhookAuthDialog } from '@/components/webhooks/webhook-auth-dialog';
import {
  EMPTY_WEBHOOK_AUTH,
  isWebhookAuthComplete,
  WebhookAuthFields,
} from '@/components/webhooks/webhook-auth-fields';
import type { WebhookDeliverTo, WebhookSubscription } from '@/types';

export const Route = createFileRoute('/webhooks')({
  component: WebhooksPage,
});

const DELIVER_LABELS: Record<WebhookDeliverTo, string> = {
  all: 'All channels',
  chat: 'Chat',
  slack: 'Slack',
  teams: 'Microsoft Teams',
};

const EMPTY_FORM = {
  name: '',
  description: '',
  events: '',
  deliverTo: 'all' as WebhookDeliverTo,
  deliverOnly: false,
  prompt: '',
  ...EMPTY_WEBHOOK_AUTH,
};

function WebhooksPage() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [authTarget, setAuthTarget] = useState<WebhookSubscription | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const { fieldErrors, clearFieldError, handleError, reset: resetErrors } = useFormErrors();

  const { data: receiver, isLoading: receiverLoading } = useQuery({
    queryKey: ['webhook-receiver', agent.agentId],
    queryFn: () => runtimeApi.getWebhookReceiver(),
  });

  const { data: subscriptions, isLoading: subsLoading } = useQuery({
    queryKey: ['webhook-subscriptions', agent.agentId],
    queryFn: () => runtimeApi.listWebhookSubscriptions(),
  });

  const receiverMut = useMutation({
    mutationFn: (enabled: boolean) => runtimeApi.setWebhookReceiver(enabled),
    onSettled: () => {
      return queryClient.invalidateQueries({ queryKey: ['webhook-receiver', agent.agentId] });
    },
  });

  const createMut = useMutation({
    mutationFn: (input: typeof EMPTY_FORM) =>
      runtimeApi.createWebhookSubscription({
        name: input.name.trim(),
        description: input.description.trim() || undefined,
        events: input.events.trim() || undefined,
        prompt: input.prompt.trim() || undefined,
        deliverTo: input.deliverTo,
        deliverOnly: input.deliverOnly,
        ...(input.authType !== 'none'
          ? {
              authType: input.authType,
              authHeader: input.authHeader.trim(),
              authPrefix: input.authPrefix || undefined,
              authAlgorithm: input.authAlgorithm,
              authEncoding: input.authEncoding,
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

  const setField = <K extends keyof typeof EMPTY_FORM>(key: K, value: (typeof EMPTY_FORM)[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    clearFieldError(key);
  };

  const resetModal = () => {
    setIsCreating(false);
    setForm(EMPTY_FORM);
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
            ) : `Webhook port ${receiver?.port} is not exposed. Expose it through your ingress or tunnel and use that address for deliveries.`
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
                  deliveryLabel={DELIVER_LABELS[s.deliverTo]}
                  isUpdating={toggleMut.isPending && toggleMut.variables?.id === s.id}
                  onToggle={(isActive) => toggleMut.mutate({ id: s.id, isActive })}
                  onAuthenticate={() => setAuthTarget(s)}
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
                          title="Sender authentication"
                          aria-label={`Authentication for ${s.name}`}
                          className="text-muted-foreground"
                          onClick={(e: React.MouseEvent) => {
                            e.stopPropagation();
                            setAuthTarget(s);
                          }}
                        >
                          <KeyRound className="h-4 w-4" />
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
        <FieldGroup>
          {/* No legend on the first group: the name/description/events fields
              are self-evident, and a heading above them would just repeat the
              dialog title. */}
          <FieldSet>
            <Field data-invalid={Boolean(fieldErrors.name)}>
              <FieldLabel htmlFor="webhook-name">
                Name <span aria-hidden="true" className="text-muted-foreground">*</span>
              </FieldLabel>
              <Input
                id="webhook-name"
                aria-required="true"
                aria-invalid={Boolean(fieldErrors.name) || undefined}
                value={form.name}
                onChange={(e) => setField('name', e.target.value)}
                placeholder="e.g. github-push"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
              {fieldErrors.name ? (
                <FieldError>{fieldErrors.name}</FieldError>
              ) : (
                <FieldDescription>
                  Use lowercase letters, numbers, hyphens, or underscores. This becomes the endpoint name.
                </FieldDescription>
              )}
            </Field>
            <Field data-invalid={Boolean(fieldErrors.description)}>
              <FieldLabel htmlFor="webhook-description">Description</FieldLabel>
              <Input
                id="webhook-description"
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                placeholder="What this webhook does (optional)"
              />
              {fieldErrors.description && <FieldError>{fieldErrors.description}</FieldError>}
            </Field>
            <Field data-invalid={Boolean(fieldErrors.events)}>
              <FieldLabel htmlFor="webhook-events">Events</FieldLabel>
              <Input
                id="webhook-events"
                value={form.events}
                onChange={(e) => setField('events', e.target.value)}
                placeholder="comma-separated, leave empty for all"
                className="font-mono"
              />
              {fieldErrors.events ? (
                <FieldError>{fieldErrors.events}</FieldError>
              ) : (
                <FieldDescription>
                  Matched against GitHub/GitLab event headers. Leave empty for sources like
                  Alertmanager or PagerDuty.
                </FieldDescription>
              )}
            </Field>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Delivery</FieldLegend>
            <div className="flex flex-wrap items-start gap-6">
              <Field data-invalid={Boolean(fieldErrors.deliverTo)} className="w-auto">
                <FieldLabel htmlFor="webhook-deliver-to">Deliver to</FieldLabel>
                <Select
                  value={form.deliverTo}
                  onValueChange={(value) => {
                    if (value) setField('deliverTo', value as WebhookDeliverTo);
                  }}
                >
                  <SelectTrigger id="webhook-deliver-to" className="min-w-40">
                    <SelectValue>{DELIVER_LABELS[form.deliverTo]}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All channels</SelectItem>
                    <SelectItem value="chat">Chat</SelectItem>
                    <SelectItem value="slack">Slack</SelectItem>
                    <SelectItem value="teams">Microsoft Teams</SelectItem>
                  </SelectContent>
                </Select>
                {fieldErrors.deliverTo && <FieldError>{fieldErrors.deliverTo}</FieldError>}
              </Field>
              <Field className="w-auto">
                <FieldLabel htmlFor="webhook-deliver-only">Deliver only</FieldLabel>
                <label className="flex items-center gap-2 text-sm" htmlFor="webhook-deliver-only">
                  <Checkbox
                    id="webhook-deliver-only"
                    checked={form.deliverOnly}
                    onCheckedChange={(checked: boolean) => setField('deliverOnly', checked)}
                  />
                  Skip the agent, deliver payload directly
                </label>
              </Field>
            </div>
            <Field data-invalid={Boolean(fieldErrors.prompt)}>
              <FieldLabel htmlFor="webhook-prompt">{form.deliverOnly ? 'Message template' : 'Prompt'}</FieldLabel>
              <Textarea
                id="webhook-prompt"
                value={form.prompt}
                onChange={(e) => setField('prompt', e.target.value)}
                placeholder={form.deliverOnly ? 'Message to deliver, e.g. Alert: {status}' : 'Instructions for the agent when this webhook fires (optional)'}
                rows={3}
              />
              {fieldErrors.prompt ? (
                <FieldError>{fieldErrors.prompt}</FieldError>
              ) : (
                <FieldDescription>
                  Supports <code>{'{field.path}'}</code> payload substitution and{' '}
                  <code>{'{__raw__}'}</code> for the full payload. Empty = raw payload dump.
                </FieldDescription>
              )}
            </Field>
          </FieldSet>

          <FieldSeparator />

          <FieldSet>
            <FieldLegend>Authentication</FieldLegend>
            {/* Own setter: the auth field group is keyed on its own value type,
                which isn't the wider form type `setField` is generic over. */}
            <WebhookAuthFields
              values={form}
              onChange={(key, value) => {
                setForm((f) => ({ ...f, [key]: value }));
                clearFieldError(key);
              }}
              fieldErrors={fieldErrors}
            />
          </FieldSet>
        </FieldGroup>
      </CreateModal>

      {authTarget && (
        <WebhookAuthDialog subscription={authTarget} onClose={() => setAuthTarget(null)} />
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
