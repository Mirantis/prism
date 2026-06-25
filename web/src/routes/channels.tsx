import { useEffect, useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Hash, ScrollText, Plus, Trash2, Slack } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
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
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { useFormErrors } from '@/hooks/use-form-errors';
import { CreateModal } from '@/components/shared/create-modal';
import { DeleteConfirm } from '@/components/shared/delete-confirm';
import type { SlackChannelMapping, SlackHeartbeatTrigger } from '@/types';

export const Route = createFileRoute('/channels')({
  component: ChannelsPage,
});

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function toMinSec(seconds: number): { min: number; sec: number } {
  return { min: Math.floor(seconds / 60), sec: seconds % 60 };
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

function ChannelsPage() {
  const agent = useAgent();

  const { data: workspacesResp } = useQuery({
    queryKey: ['slack-workspaces'],
    queryFn: () => runtimeApi.slackWorkspaces(),
  });
  const workspace = workspacesResp?.workspaces[0];
  const isConfigured = !!workspace;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Channels</h2>
        <p className="text-sm text-muted-foreground">
          Link the agent to messaging channels and configure a heartbeat trigger. Currently
          supports Slack; more integrations coming.
        </p>
      </div>

      {!isConfigured ? (
        <Card>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <Slack className="h-10 w-10 mb-2 opacity-50" />
              <p className="text-sm">No Slack workspace configured</p>
              <p className="text-xs">
                Set <code>SLACK_BOT_TOKEN</code> + <code>SLACK_APP_TOKEN</code> in the runtime env
                and restart.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b pb-3">
            <div className="flex items-center gap-2">
              <Slack className="size-5 text-muted-foreground" />
              <h3 className="text-base font-semibold">Slack</h3>
            </div>
            <Badge variant="secondary" className="font-mono text-xs">
              {workspace.teamName}
            </Badge>
          </div>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Channels</CardTitle>
                <Hash className="h-4 w-4 text-muted-foreground" />
              </div>
            </CardHeader>
            <CardContent>
              <SlackModeSections
                agentId={agent.agentId}
                userId={agent.userId}
                agentName={agent.name}
                connectionId={workspace.teamId}
              />
            </CardContent>
          </Card>

          <HeartbeatTriggersCard
            agentId={agent.agentId}
            userId={agent.userId}
            connectionId={workspace.teamId}
          />
        </div>
      )}
    </div>
  );
}

// ============================================================================
// Personal / Team mode sections — mirrors legacy frontend AgentChannelsSection
// ============================================================================

function SlackModeSections({
  agentId,
  userId,
  agentName,
  connectionId,
}: {
  agentId: string;
  userId: string;
  agentName: string;
  /** Slack workspace teamId — must match the connection id the runtime's
   *  Slack adapter uses when registering message handlers, so DM lookups
   *  hit the SlackMapping rows created during link. */
  connectionId: string;
}) {
  const queryClient = useQueryClient();

  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [channelLinkCode, setChannelLinkCode] = useState<string | null>(null);
  const [isUnlinkDmOpen, setIsUnlinkDmOpen] = useState(false);
  const [channelToUnlink, setChannelToUnlink] = useState<SlackChannelMapping | null>(null);
  const [prevChannelCount, setPrevChannelCount] = useState<number | null>(null);

  const { data: linkStatus } = useQuery({
    queryKey: ['slack-link-status', agentId, connectionId],
    queryFn: () => runtimeApi.slackLinkStatus(),
    refetchInterval: verificationCode ? 3000 : false,
  });

  const { data: channelsResp } = useQuery({
    queryKey: ['slack-channels', agentId, connectionId],
    queryFn: () => runtimeApi.slackChannelMappings(),
    refetchInterval: channelLinkCode ? 3000 : false,
  });

  // Auto-clear DM code once the link succeeds.
  useEffect(() => {
    if (verificationCode && linkStatus?.hasDmMapping) setVerificationCode(null);
  }, [verificationCode, linkStatus?.hasDmMapping]);

  // Auto-clear channel code once a new channel appears in the list.
  useEffect(() => {
    const count = channelsResp?.channels.length ?? 0;
    if (channelLinkCode && prevChannelCount !== null && count > prevChannelCount) {
      setChannelLinkCode(null);
    }
    setPrevChannelCount(count);
  }, [channelsResp?.channels.length, channelLinkCode, prevChannelCount]);

  const dmLinkMutation = useMutation({
    mutationFn: () =>
      runtimeApi.createSlackVerificationCode({
        type: 'DM',
        lensUserId: userId,
        connectionId,
        agentId,
        agentName,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
    onSuccess: (data) => setVerificationCode(data.code),
  });

  const dmUnlinkMutation = useMutation({
    mutationFn: () => runtimeApi.deleteDmMapping(),
    onSuccess: () => {
      setIsUnlinkDmOpen(false);
      queryClient.invalidateQueries({ queryKey: ['slack-link-status', agentId, connectionId] });
      queryClient.invalidateQueries({ queryKey: ['slack-channels', agentId, connectionId] });
    },
  });

  const channelCodeMutation = useMutation({
    mutationFn: () =>
      runtimeApi.createSlackVerificationCode({
        type: 'CHANNEL',
        lensUserId: userId,
        connectionId,
        agentId,
        agentName,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
    onSuccess: (data) => setChannelLinkCode(data.code),
  });

  const unlinkChannelMutation = useMutation({
    mutationFn: (channelId: string) => runtimeApi.deleteChannelMapping(channelId),
    onSuccess: () => {
      setChannelToUnlink(null);
      queryClient.invalidateQueries({ queryKey: ['slack-channels', agentId, connectionId] });
    },
  });

  const hasLinkedChannel = (channelsResp?.channels.length ?? 0) > 0;
  const isPersonalLinked = !!linkStatus?.hasDmMapping;

  const personalSection = (
    <div className="rounded-lg border p-3">
      <h4 className="text-sm font-semibold mb-1">Personal Mode</h4>
      <p className="text-sm text-muted-foreground mb-3">
        Chat privately with this agent via Slack DM
      </p>
      {isPersonalLinked ? (
        <>
          <div className="flex items-center justify-between p-2 rounded-md bg-accent">
            <span className="flex items-center gap-2 text-sm">
              Linked to DM with {linkStatus?.slackUserId}
            </span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setIsUnlinkDmOpen(true)}
              disabled={dmUnlinkMutation.isPending}
            >
              Unlink
            </Button>
          </div>
          <p className="text-xs text-muted-foreground mt-2 italic">
            To switch to Team Mode, unlink Personal Mode first.
          </p>
        </>
      ) : verificationCode ? (
        <div className="text-center">
          <p className="text-sm mb-1">
            Send this code to <strong>@{agentName}</strong> in a Slack DM:
          </p>
          <div className="font-mono text-2xl font-bold tracking-widest text-primary bg-primary/10 p-2 rounded-md mb-2 select-all">
            {verificationCode}
          </div>
          <p className="text-xs text-muted-foreground mb-2">Expires in 15 minutes</p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setVerificationCode(null);
              queryClient.invalidateQueries({
                queryKey: ['slack-link-status', agentId, connectionId],
              });
            }}
          >
            Generate new code
          </Button>
        </div>
      ) : (
        <>
          <Button onClick={() => dmLinkMutation.mutate()} disabled={dmLinkMutation.isPending}>
            {dmLinkMutation.isPending ? 'Generating...' : 'Link Account'}
          </Button>
          {dmLinkMutation.isError && (
            <p className="text-sm text-destructive mt-2">{getErrorMessage(dmLinkMutation.error)}</p>
          )}
        </>
      )}
    </div>
  );

  const teamSection = (
    <div className="rounded-lg border p-3">
      <h4 className="text-sm font-semibold mb-1">Team Mode</h4>
      <p className="text-sm text-muted-foreground mb-3">
        Invite this agent to Slack channels to help your team
      </p>
      {hasLinkedChannel && (
        <div className="mb-3">
          {channelsResp?.channels.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center justify-between p-1.5 rounded-md bg-accent mb-1.5"
            >
              <span className="text-sm font-medium text-primary">
                #{ch.channelName || ch.channelId}
              </span>
              <Button variant="secondary" size="sm" onClick={() => setChannelToUnlink(ch)}>
                Unlink
              </Button>
            </div>
          ))}
          <p className="text-xs text-muted-foreground mt-2 italic">
            To switch to Personal Mode, unlink all channels first.
          </p>
        </div>
      )}
      {!hasLinkedChannel &&
        (channelLinkCode ? (
          <div className="text-center">
            <p className="text-sm mb-1">
              Invite <strong>@{agentName}</strong> to a channel, then enter this code:
            </p>
            <div className="font-mono text-2xl font-bold tracking-widest text-primary bg-primary/10 p-2 rounded-md mb-2 select-all">
              {channelLinkCode}
            </div>
            <p className="text-xs text-muted-foreground mb-2">Expires in 15 minutes</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setChannelLinkCode(null);
                queryClient.invalidateQueries({
                  queryKey: ['slack-channels', agentId, connectionId],
                });
              }}
            >
              Generate new code
            </Button>
          </div>
        ) : (
          <>
            <Button
              onClick={() => channelCodeMutation.mutate()}
              disabled={channelCodeMutation.isPending}
            >
              {channelCodeMutation.isPending ? 'Generating...' : 'Get Channel Link Code'}
            </Button>
            {channelCodeMutation.isError && (
              <p className="text-sm text-destructive mt-2">
                {getErrorMessage(channelCodeMutation.error)}
              </p>
            )}
          </>
        ))}
    </div>
  );

  let content: React.ReactNode;
  if (isPersonalLinked && !hasLinkedChannel) content = personalSection;
  else if (hasLinkedChannel && !isPersonalLinked) content = teamSection;
  else
    content = (
      <>
        {personalSection}
        {teamSection}
      </>
    );

  return (
    <>
      <div className="flex flex-col gap-4">{content}</div>

      {isUnlinkDmOpen && (
        <DeleteConfirm
          isOpen
          onClose={() => setIsUnlinkDmOpen(false)}
          onConfirm={() => dmUnlinkMutation.mutate()}
          isDeleting={dmUnlinkMutation.isPending}
          entityType="Slack account"
          entityName={linkStatus?.slackUserId ?? 'Slack user'}
          warning="You will no longer receive DM notifications for this agent via Slack."
        />
      )}

      {channelToUnlink && (
        <DeleteConfirm
          isOpen
          onClose={() => setChannelToUnlink(null)}
          onConfirm={() =>
            channelToUnlink.channelId &&
            unlinkChannelMutation.mutate(channelToUnlink.channelId)
          }
          isDeleting={unlinkChannelMutation.isPending}
          entityType="channel"
          entityName={`#${channelToUnlink.channelName || channelToUnlink.channelId}`}
        />
      )}
    </>
  );
}

// ============================================================================
// Heartbeat triggers — mirrors legacy structure (single trigger, min/sec edit)
// ============================================================================

function HeartbeatTriggersCard({
  agentId,
  userId,
  connectionId,
}: {
  agentId: string;
  userId: string;
  connectionId: string;
}) {
  const queryClient = useQueryClient();
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [form, setForm] = useState({ channelId: '', channelName: '', throttleSeconds: 60 });
  const { fieldErrors, clearFieldError, handleError, reset: resetErrors } = useFormErrors();

  const { data: triggers = [], isLoading } = useQuery({
    queryKey: ['heartbeat-triggers', agentId],
    queryFn: () => runtimeApi.listHeartbeatTriggers(userId),
  });

  const createMut = useMutation({
    mutationFn: () =>
      runtimeApi.createHeartbeatTrigger({
        connectionId,
        channelId: form.channelId.trim(),
        channelName: form.channelName.trim() || undefined,
        userId,
        throttleSeconds: form.throttleSeconds,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['heartbeat-triggers', agentId] });
      resetModal();
    },
  });

  const deleteMut = useMutation({
    mutationFn: (triggerId: string) =>
      runtimeApi.deleteHeartbeatTrigger(triggerId, userId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['heartbeat-triggers', agentId] });
      setDeleteTarget(null);
    },
  });

  const setField = (key: 'channelId' | 'channelName' | 'throttleSeconds', value: string | number) => {
    setForm((f) => ({ ...f, [key]: value }));
    clearFieldError(key);
  };

  const resetModal = () => {
    setIsCreating(false);
    setForm({ channelId: '', channelName: '', throttleSeconds: 60 });
    resetErrors();
  };

  const handleCreate = async () => {
    try {
      await createMut.mutateAsync();
    } catch (e) {
      handleError(e);
    }
  };

  const throttleMinSec = toMinSec(form.throttleSeconds);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle>Heartbeat trigger</CardTitle>
          {triggers.length === 0 && (
            <Button size="sm" onClick={() => setIsCreating(true)}>
              <Plus className="mr-1 size-4" />
              Add trigger
            </Button>
          )}
        </div>
      </CardHeader>
      {isLoading ? (
        <CardContent>
          <Skeleton className="h-24" />
        </CardContent>
      ) : triggers.length > 0 ? (
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead>Throttle</TableHead>
                <TableHead className="w-[50px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {triggers.map((t: SlackHeartbeatTrigger) => (
                <TableRow key={t.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <div className="flex size-8 items-center justify-center rounded-md bg-muted">
                        <Hash className="size-4 text-muted-foreground" />
                      </div>
                      <span className="font-medium">
                        {t.slackChannelName
                          ? t.slackChannelName.replace(/^#/, '')
                          : t.slackChannelId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDuration(t.throttleSeconds)}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={() =>
                        setDeleteTarget({
                          id: t.id,
                          name: t.slackChannelName ?? t.slackChannelId,
                        })
                      }
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      ) : (
        <CardContent>
          <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
            <ScrollText className="h-10 w-10 mb-2 opacity-50" />
            <p className="text-sm">No heartbeat trigger</p>
            <p className="text-xs">
              When a message arrives in a configured Slack channel, the agent runs a heartbeat
              with those messages as context.
            </p>
          </div>
        </CardContent>
      )}

      <CreateModal
        isOpen={isCreating}
        onClose={resetModal}
        title="Add heartbeat trigger"
        onSubmit={handleCreate}
        isSubmitting={createMut.isPending}
        submitLabel="Add"
        submitDisabled={!form.channelId.trim()}
      >
        <FieldGroup>
          <Field data-invalid={!!fieldErrors.channelId}>
            <FieldLabel htmlFor="hb-channel-id">Channel ID</FieldLabel>
            <Input
              id="hb-channel-id"
              aria-invalid={!!fieldErrors.channelId || undefined}
              value={form.channelId}
              onChange={(e) => setField('channelId', e.target.value)}
              placeholder="C0123ABCD"
              className="font-mono"
            />
            {fieldErrors.channelId ? (
              <FieldError>{fieldErrors.channelId}</FieldError>
            ) : (
              <FieldDescription>Find the channel ID via Slack channel details.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={!!fieldErrors.channelName}>
            <FieldLabel htmlFor="hb-channel-name">Channel name</FieldLabel>
            <Input
              id="hb-channel-name"
              aria-invalid={!!fieldErrors.channelName || undefined}
              value={form.channelName}
              onChange={(e) => setField('channelName', e.target.value)}
              placeholder="alerts"
            />
            {fieldErrors.channelName ? (
              <FieldError>{fieldErrors.channelName}</FieldError>
            ) : (
              <FieldDescription>Optional, for display only.</FieldDescription>
            )}
          </Field>
          <Field data-invalid={!!fieldErrors.throttleSeconds}>
            <FieldLabel>Throttle</FieldLabel>
            <div className="flex items-center gap-2">
              <Input
                type="number"
                min={0}
                aria-label="Throttle minutes"
                value={throttleMinSec.min}
                onChange={(e) =>
                  setField(
                    'throttleSeconds',
                    (parseInt(e.target.value, 10) || 0) * 60 + (form.throttleSeconds % 60),
                  )
                }
                className="w-[80px]"
              />
              <span className="text-sm text-muted-foreground">min</span>
              <Input
                type="number"
                min={0}
                max={59}
                aria-label="Throttle seconds"
                value={throttleMinSec.sec}
                onChange={(e) =>
                  setField(
                    'throttleSeconds',
                    Math.floor(form.throttleSeconds / 60) * 60 + (parseInt(e.target.value, 10) || 0),
                  )
                }
                className="w-[80px]"
              />
              <span className="text-sm text-muted-foreground">sec</span>
            </div>
            {fieldErrors.throttleSeconds && <FieldError>{fieldErrors.throttleSeconds}</FieldError>}
          </Field>
        </FieldGroup>
      </CreateModal>

      {deleteTarget && (
        <DeleteConfirm
          isOpen
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMut.mutate(deleteTarget.id)}
          isDeleting={deleteMut.isPending}
          entityType="heartbeat trigger"
          entityName={`#${deleteTarget.name.replace(/^#/, '')}`}
        />
      )}
    </Card>
  );
}
