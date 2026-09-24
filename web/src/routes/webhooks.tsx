import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { EmptyState } from '@/components/shared/empty-state';
import { PageHeader } from '@/components/shared/page-header';
import { Card, CardContent } from '@/components/ui/card';
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
import { Check, Copy, Plus, Trash2, Webhook as WebhookIcon } from 'lucide-react';
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
  const [copiedId, setCopiedId] = useState<string | null>(null);
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

  const copyUrl = async (id: string, name: string) => {
    try {
      await navigator.clipboard.writeText(endpointUrl(name));
    } catch {
      // Clipboard is unavailable (insecure context / permission denied) —
      // skip the confirmation tick; the path stays selectable in the row.
      return;
    }
    setCopiedId(id);
    setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1500);
  };

  if (receiverLoading || subsLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 mt-6" />
      </div>
    );
  }

  const enabled = receiver?.enabled === true;

  return (
    <div className="page-content space-y-8">
      <PageHeader
        title="Webhooks"
        description="Connect external events to your agent and choose where responses go."
        actions={
          <>
            {enabled && (
              <Button onClick={() => setIsCreating(true)}>
                <Plus className="size-4" />
                New subscription
              </Button>
            )}
          </>
        }
      />

      {!enabled && (
        <Card className="border-amber-500/50">
          <CardContent>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                <WebhookIcon className="mt-1 h-5 w-5 shrink-0 text-amber-500" />
                <div>
                  <p className="font-medium">Webhook receiver disabled</p>
                  <p className="text-sm text-muted-foreground">
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
                <WebhookIcon className="mr-1 h-4 w-4" />
                {receiverMut.isPending ? 'Enabling...' : 'Enable Webhooks'}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div>
        <h3 className="font-semibold">Subscriptions ({subscriptions?.length ?? 0})</h3>
        <p className="text-sm text-muted-foreground">
          Subscription changes apply immediately. Disabled subscriptions reject incoming events.
        </p>
      </div>

      {subscriptions && subscriptions.length > 0 ? (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
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
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="flex size-8 items-center justify-center rounded-md bg-muted">
                          <WebhookIcon className="size-4 text-muted-foreground" />
                        </div>
                        <div>
                          <span className="font-medium">{s.name}</span>
                          {s.description && (
                            <p className="text-xs text-muted-foreground">{s.description}</p>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-sm text-muted-foreground">
                      {s.events ? (
                        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{s.events}</code>
                      ) : (
                        'all'
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {DELIVER_LABELS[s.deliverTo]}
                      {s.deliverOnly && <span className="block text-xs">direct — no agent</span>}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <code className="max-w-[220px] truncate rounded bg-muted px-1.5 py-0.5 font-mono text-xs">
                          /agents/webhooks/{s.name}
                        </code>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          title="Copy endpoint URL"
                          onClick={() => copyUrl(s.id, s.name)}
                        >
                          {copiedId === s.id ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                        </Button>
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
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent>
            <EmptyState
              icon={WebhookIcon}
              title="No webhook subscriptions yet."
              description="Give an external system its own endpoint and choose what your agent does next."
              action={
                enabled ? (
                  <Button variant="outline" onClick={() => setIsCreating(true)}>
                    <Plus className="size-4" />
                    Create a subscription
                  </Button>
                ) : undefined
              }
            />
          </CardContent>
        </Card>
      )}

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
    </div>
  );
}
