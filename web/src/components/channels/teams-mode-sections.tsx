import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Hash, Plus, Star, Trash2 } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { runtimeApi } from '@/api/runtime-client';
import { DeleteConfirm } from '@/components/shared/delete-confirm';
import type { TeamsChannelMapping } from '@/types';

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong. Please try again.';
}

/**
 * Personal / Team mode sections for Microsoft Teams — mirrors the Slack
 * sections on the same page: link a personal chat or channels with a
 * 6-character verification code, list linked channels, pick the main channel.
 */
export function TeamsModeSections({
  agentId,
  userId,
  agentName,
  connectionId,
}: {
  agentId: string;
  userId: string;
  agentName: string;
  /** The Teams connection id — the tenant id (see the runtime's `lib/teams-config.ts`). */
  connectionId: string;
}) {
  const queryClient = useQueryClient();

  const [verificationCode, setVerificationCode] = useState<string | null>(null);
  const [channelLinkCode, setChannelLinkCode] = useState<string | null>(null);
  const [isUnlinkDmOpen, setIsUnlinkDmOpen] = useState(false);
  const [channelToUnlink, setChannelToUnlink] = useState<TeamsChannelMapping | null>(null);
  const [prevChannelCount, setPrevChannelCount] = useState<number | null>(null);

  const { data: linkStatus } = useQuery({
    queryKey: ['teams-link-status', agentId, connectionId],
    queryFn: () => runtimeApi.teamsLinkStatus(),
    refetchInterval: verificationCode ? 3000 : false,
  });

  const { data: channelsResp } = useQuery({
    queryKey: ['teams-channels', agentId, connectionId],
    queryFn: () => runtimeApi.teamsChannelMappings(),
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
      runtimeApi.createTeamsVerificationCode({
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
    mutationFn: () => runtimeApi.deleteTeamsDmMapping(),
    onSuccess: () => {
      setIsUnlinkDmOpen(false);
      queryClient.invalidateQueries({ queryKey: ['teams-link-status', agentId, connectionId] });
      queryClient.invalidateQueries({ queryKey: ['teams-channels', agentId, connectionId] });
    },
  });

  const channelCodeMutation = useMutation({
    mutationFn: () =>
      runtimeApi.createTeamsVerificationCode({
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
    mutationFn: (conversationId: string) => runtimeApi.deleteTeamsChannelMapping(conversationId),
    onSuccess: () => {
      setChannelToUnlink(null);
      queryClient.invalidateQueries({ queryKey: ['teams-channels', agentId, connectionId] });
    },
  });

  const setMainMutation = useMutation({
    mutationFn: (conversationId: string) => runtimeApi.setTeamsMainChannel(conversationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['teams-channels', agentId, connectionId] });
    },
  });

  const hasLinkedChannel = (channelsResp?.channels.length ?? 0) > 0;
  const isPersonalLinked = Boolean(linkStatus?.hasDmMapping);

  const personalSection = (
    <div className="rounded-lg border p-3">
      <h4 className="text-sm font-semibold mb-1">Personal Mode</h4>
      <p className="text-sm text-muted-foreground mb-3">
        Chat privately with this agent in a Microsoft Teams personal chat
      </p>
      {isPersonalLinked ? (
        <>
          <div className="flex items-center justify-between p-2 rounded-md bg-accent">
            <span className="flex items-center gap-2 text-sm">Linked to a Teams account</span>
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
            Send this code to <strong>{agentName}</strong> in a Teams chat:
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
                queryKey: ['teams-link-status', agentId, connectionId],
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
      <div className="flex items-center justify-between mb-1">
        <h4 className="text-sm font-semibold">Team Mode</h4>
        {!channelLinkCode && (
          <Button
            size="sm"
            onClick={() => channelCodeMutation.mutate()}
            disabled={channelCodeMutation.isPending}
          >
            <Plus className="mr-1 size-4" />
            {channelCodeMutation.isPending ? 'Generating...' : 'Add channel'}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground mb-3">
        Add this agent to Teams channels to help your team. Heartbeat alerts post to
        the <strong>main</strong> channel; scheduled tasks post to the channel they were
        created in (or the main channel).
      </p>

      {channelCodeMutation.isError && (
        <p className="text-sm text-destructive mb-2">
          {getErrorMessage(channelCodeMutation.error)}
        </p>
      )}

      {channelLinkCode && (
        <div className="rounded-md border bg-primary/5 p-3 mb-3 text-center">
          <p className="text-sm mb-1">
            Add <strong>{agentName}</strong> to the channel, then @mention it with this code:
          </p>
          <div className="font-mono text-2xl font-bold tracking-widest text-primary bg-primary/10 p-2 rounded-md mb-2 select-all">
            {channelLinkCode}
          </div>
          <p className="text-xs text-muted-foreground mb-2">
            Expires in 15 minutes · Waiting for the code in Teams…
          </p>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setChannelLinkCode(null);
              queryClient.invalidateQueries({
                queryKey: ['teams-channels', agentId, connectionId],
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
                      <div className="flex size-8 items-center justify-center rounded-md bg-muted">
                        <Hash className="size-4 text-muted-foreground" />
                      </div>
                      <span className="font-medium">{ch.channelName || ch.conversationId}</span>
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
                        onClick={() => setMainMutation.mutate(ch.conversationId)}
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
          <div className="flex flex-col items-center justify-center py-8 text-muted-foreground">
            <Hash className="h-10 w-10 mb-2 opacity-50" />
            <p className="text-sm">No channels linked</p>
            <p className="text-xs">Add the agent to a Teams channel to get started.</p>
          </div>
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
          entityType="Teams account"
          entityName="Microsoft Teams chat"
          warning="You will no longer receive notifications for this agent in Microsoft Teams."
        />
      )}

      {channelToUnlink && (
        <DeleteConfirm
          isOpen
          onClose={() => setChannelToUnlink(null)}
          onConfirm={() =>
            channelToUnlink.conversationId &&
            unlinkChannelMutation.mutate(channelToUnlink.conversationId)
          }
          isDeleting={unlinkChannelMutation.isPending}
          entityType="channel"
          entityName={channelToUnlink.channelName || channelToUnlink.conversationId}
        />
      )}
    </>
  );
}
