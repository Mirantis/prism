import { useState } from 'react';
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
} from '@/components/ui/field';
import { Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
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
import type { WebhookDeliverTo } from '@/types';

export const Route = createFileRoute('/webhooks')({
  component: WebhooksPage,
});

const DELIVER_LABELS: Record<WebhookDeliverTo, string> = {
  all: 'All channels',
  chat: 'Chat',
  slack: 'Slack',
};

const EMPTY_FORM = {
  name: '',
  description: '',
  events: '',
  deliverTo: 'all' as WebhookDeliverTo,
  deliverOnly: false,
  prompt: '',
};

function WebhooksPage() {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['webhook-receiver', agent.agentId] });
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

  const endpointUrl = (name: string) => `${window.location.origin}/agents/webhooks/${name}`;

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

      {!enabled && (
        <div className="flex flex-col gap-4 rounded-xl bg-warning/8 p-4 ring-1 ring-warning/30 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3">
            <IconTile icon={WebhookIcon} tone="warning" size="md" />
            <div className="space-y-0.5">
              <p className="font-medium text-strong">Webhook receiver disabled</p>
              <p className="text-sm text-foreground/75">
                Enable the receiver to accept incoming HTTP events. Subscriptions deliver agent
                responses to your connected channels (web chat and Slack).
              </p>
            </div>
          </div>
          <Button
            onClick={() => receiverMut.mutate(true)}
            disabled={receiverMut.isPending}
            data-testid="enable-webhooks"
          >
            <WebhookIcon />
            {receiverMut.isPending ? 'Enabling...' : 'Enable Webhooks'}
          </Button>
        </div>
      )}

      <section className="space-y-3">
        <SectionHeader
          title={`Subscriptions (${subscriptions?.length ?? 0})`}
          description="Changes apply immediately. A disabled subscription rejects incoming events."
        />

        {subscriptions && subscriptions.length > 0 ? (
          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">Name</TableHead>
                  <TableHead className="hidden md:table-cell">Events</TableHead>
                  <TableHead>Delivery</TableHead>
                  <TableHead>Endpoint</TableHead>
                  <TableHead className="w-[60px]">Active</TableHead>
                  <TableHead className="w-[50px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="pl-4">
                      <div className="flex items-center gap-3">
                        <IconTile icon={WebhookIcon} tone={s.isActive ? 'success' : 'neutral'} />
                        <div className="min-w-0">
                          <span className="font-medium text-strong">{s.name}</span>
                          {s.description && (
                            <p className="max-w-xs truncate text-xs text-muted-foreground">{s.description}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden text-sm text-muted-foreground md:table-cell">
                      {s.events ? <code className="font-mono text-xs">{s.events}</code> : 'all'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {DELIVER_LABELS[s.deliverTo]}
                      {s.deliverOnly && <span className="block text-xs text-muted-foreground">direct — no agent</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code className="max-w-[220px] truncate font-mono text-xs">/agents/webhooks/{s.name}</code>
                        <CopyButton text={endpointUrl(s.name)} label="Copy endpoint URL" />
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={s.isActive}
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
        ) : (
          <Card>
            <EmptyState
              icon={WebhookIcon}
              title="No webhook subscriptions yet"
              description="Create a subscription to give an external system its own endpoint."
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
        submitDisabled={!form.name.trim()}
      >
        <FieldGroup>
          <Field data-invalid={Boolean(fieldErrors.name)}>
            <FieldLabel htmlFor="webhook-name">Name</FieldLabel>
            <Input
              id="webhook-name"
              aria-invalid={Boolean(fieldErrors.name) || undefined}
              value={form.name}
              onChange={(e) => setField('name', e.target.value)}
              placeholder="e.g. github-push"
              className="font-mono"
            />
            {fieldErrors.name ? (
              <FieldError>{fieldErrors.name}</FieldError>
            ) : (
              <FieldDescription>
                Becomes the endpoint path: <code>/agents/webhooks/&lt;name&gt;</code>
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
            <FieldLabel htmlFor="webhook-prompt">Prompt</FieldLabel>
            <Textarea
              id="webhook-prompt"
              value={form.prompt}
              onChange={(e) => setField('prompt', e.target.value)}
              placeholder="Instructions for the agent when this webhook fires (optional)"
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
        </FieldGroup>
      </CreateModal>

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
