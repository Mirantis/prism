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
import { Hash, MessagesSquare, ScrollText, Plus, Trash2, Slack, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Page } from '@/components/layout/page';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { IconTile } from '@/components/shared/icon-tile';
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
import { TeamsModeSections } from '@/components/channels/teams-mode-sections';
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
  const { data: teamsWorkspacesResp } = useQuery({
    queryKey: ['teams-workspaces'],
    queryFn: () => runtimeApi.teamsWorkspaces(),
  });
  const workspace = workspacesResp?.workspaces[0];
  const teamsWorkspace = teamsWorkspacesResp?.workspaces[0];
  // `!== undefined` (not Boolean(workspace)) so TS narrows `workspace` to
  // defined where `isConfigured` is used as a guard below.
  const isConfigured = workspace !== undefined;
  const isTeamsConfigured = teamsWorkspace !== undefined;

  return (
    <Page>
      <PageHeader
        title="Channels"
        description="Link the agent to messaging channels and set up a heartbeat trigger."
      />

      {!isConfigured && !isTeamsConfigured ? (
        <Card>
          <EmptyState
            icon={Slack}
            title="No messaging channel configured"
            description={
              <>
                Set <code>SLACK_BOT_TOKEN</code> and <code>SLACK_APP_TOKEN</code> (Slack), or{' '}
                <code>TEAMS_APP_ID</code>, <code>TEAMS_APP_PASSWORD</code> and{' '}
                <code>TEAMS_APP_TENANT_ID</code> (Microsoft Teams), in the runtime environment and
                restart.
              </>
            }
          />
        </Card>
      ) : (
        <div className="space-y-6">
          {isConfigured && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="flex items-center gap-3">
                  <IconTile icon={Slack} tone="primary" size="md" />
                  <div>
                    <h3 className="text-base font-semibold">Slack</h3>
                    <p className="text-xs text-muted-foreground">Connected workspace</p>
                  </div>
                </div>
                <Badge variant="secondary" className="h-6 gap-1.5 px-2.5 text-xs">
                  <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
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

          {isTeamsConfigured && (
            <div className="space-y-4">
              <div className="flex items-center justify-between gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
                <div className="flex items-center gap-3">
                  <IconTile icon={MessagesSquare} tone="primary" size="md" />
                  <div>
                    <h3 className="text-base font-semibold">Microsoft Teams</h3>
                    <p className="text-xs text-muted-foreground">Connected tenant</p>
                  </div>
                </div>
                <Badge variant="secondary" className="h-6 gap-1.5 px-2.5 font-mono text-xs">
                  <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
                  {teamsWorkspace.tenantId}
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
                  <TeamsModeSections
                    agentId={agent.agentId}
                    userId={agent.userId}
                    agentName={agent.name}
                    connectionId={teamsWorkspace.tenantId}
                  />
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      )}
    </Page>
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

  const setMainMutation = useMutation({
    mutationFn: (channelId: string) => runtimeApi.setMainChannel(channelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['slack-channels', agentId, connectionId] });
    },
  });

  const hasLinkedChannel = (channelsResp?.channels.length ?? 0) > 0;
  const isPersonalLinked = Boolean(linkStatus?.hasDmMapping);

  const personalSection = (
    <div className="rounded-xl bg-muted/15 p-4 ring-1 ring-border ring-inset">
      <h4 className="text-sm font-semibold mb-1">Personal Mode</h4>
      <p className="text-sm text-muted-foreground mb-3">
        Chat privately with this agent via Slack DM
      </p>
      {isPersonalLinked ? (
        <>
          <div className="flex items-center justify-between rounded-lg bg-accent p-2 pl-3">
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
          <div className="mb-2 rounded-lg bg-primary/10 p-2 font-mono text-2xl font-bold tracking-widest text-primary select-all">
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
    <div className="rounded-xl bg-muted/15 p-4 ring-1 ring-border ring-inset">
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold">Team Mode</h4>
        {!channelLinkCode && (
          <Button
            size="sm"
            onClick={() => channelCodeMutation.mutate()}
            disabled={channelCodeMutation.isPending}
          >
            <Plus />
            {channelCodeMutation.isPending ? 'Generating...' : 'Add channel'}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Invite this agent to Slack channels to help your team. Heartbeat alerts post to
        the <strong>main</strong> channel; scheduled tasks post to the channel they were
        created in (or the main channel).
      </p>

      {channelCodeMutation.isError && (
        <p className="text-sm text-destructive mb-2">
          {getErrorMessage(channelCodeMutation.error)}
        </p>
      )}

      {channelLinkCode && (
        <div className="mb-3 rounded-xl bg-primary/5 p-4 text-center ring-1 ring-primary/20 ring-inset">
          <p className="text-sm mb-1">
            Invite <strong>@{agentName}</strong> to the channel, then paste this code:
          </p>
          <div className="mb-2 rounded-lg bg-primary/10 p-2 font-mono text-2xl font-bold tracking-widest text-primary select-all">
            {channelLinkCode}
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Expires in 15 minutes · Waiting for the code in Slack…
          </p>
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
            Cancel
          </Button>
        </div>
      )}

      {hasLinkedChannel ? (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="w-[120px]">Main</TableHead>
                <TableHead className="w-[60px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {channelsResp?.channels.map((ch) => (
                <TableRow key={ch.id}>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <IconTile icon={Hash} tone={ch.isMain ? 'primary' : 'neutral'} />
                      <span className="font-medium text-strong">
                        #{(ch.channelName || ch.channelId).replace(/^#/, '')}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {ch.isMain ? (
                      <Badge variant="secondary" className="gap-1">
                        <Star className="size-3 fill-current" />
                        Main
                      </Badge>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => setMainMutation.mutate(ch.channelId)}
                        disabled={setMainMutation.isPending}
                      >
                        Set main
                      </Button>
                    )}
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Unlink"
                      onClick={() => setChannelToUnlink(ch)}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-xs text-muted-foreground mt-2 italic">
            To switch to Personal Mode, unlink all channels first.
          </p>
        </>
      ) : (
        !channelLinkCode && (
          <EmptyState
            icon={Hash}
            title="No channels linked"
            description="Invite the agent to a Slack channel to get started."
            className="py-8"
          />
        )
      )}
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
              <Plus />
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
                      <IconTile icon={Hash} />
                      <span className="font-medium text-strong">
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
          <EmptyState
            icon={ScrollText}
            title="No heartbeat trigger"
            description="When a message arrives in a configured Slack channel, the agent runs a heartbeat with those messages as context."
            className="py-8"
          />
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
          <Field data-invalid={Boolean(fieldErrors.channelId)}>
            <FieldLabel htmlFor="hb-channel-id">Channel ID</FieldLabel>
            <Input
              id="hb-channel-id"
              aria-invalid={Boolean(fieldErrors.channelId) || undefined}
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
          <Field data-invalid={Boolean(fieldErrors.channelName)}>
            <FieldLabel htmlFor="hb-channel-name">Channel name</FieldLabel>
            <Input
              id="hb-channel-name"
              aria-invalid={Boolean(fieldErrors.channelName) || undefined}
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
          <Field data-invalid={Boolean(fieldErrors.throttleSeconds)}>
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
