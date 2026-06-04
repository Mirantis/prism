import { useEffect, useState } from 'react';
import { Hash, Plus, ScrollText, Slack, Trash2 } from 'lucide-react';
import { useApi } from '../hooks/use-api';
import {
  apiDelete,
  apiPost,
  type AgentSummary,
  type SlackChannelMapping,
  type SlackHeartbeatTrigger,
  type SlackLinkStatus,
  type SlackWorkspace,
} from '../lib/api';
import { Modal } from './ui/Modal';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { EmptyState } from './ScheduledTasks';

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

const fifteenMinutesFromNow = () => new Date(Date.now() + 15 * 60 * 1000).toISOString();

/** Channels page, ported from web/src/routes/channels.tsx (Slack). */
export function Channels() {
  const { data: me } = useApi<AgentSummary>('/agents/me');
  const { data: workspacesResp, loading } = useApi<{ workspaces: SlackWorkspace[] }>(
    '/agents/slack/workspaces',
  );
  const workspace = workspacesResp?.workspaces[0];

  return (
    <div className="page">
      <div>
        <h2 className="page-title">Channels</h2>
        <p className="page-sub">
          Link the agent to messaging channels and configure a heartbeat trigger. Currently
          supports Slack.
        </p>
      </div>

      {loading && !workspacesResp ? (
        <div className="skeleton" style={{ height: '10rem' }} />
      ) : !workspace || !me ? (
        <EmptyState
          icon={<Slack size={40} />}
          title="No Slack workspace configured"
          hint="Set SLACK_BOT_TOKEN + SLACK_APP_TOKEN in the runtime env and restart."
        />
      ) : (
        <>
          <div className="section-head">
            <div className="cell-icon-text">
              <Slack size={18} />
              <h3 className="section-title">Slack</h3>
            </div>
            <span className="badge badge-secondary mono">{workspace.teamName}</span>
          </div>

          <div className="card">
            <div className="card-head">
              <h3 className="card-title">Channels</h3>
              <Hash size={16} className="card-icon" />
            </div>
            <SlackModeSections
              userId={me.userId}
              agentId={me.agentId}
              agentName={me.name}
              connectionId={workspace.teamId}
            />
          </div>

          <HeartbeatTriggersCard userId={me.userId} connectionId={workspace.teamId} />
        </>
      )}
    </div>
  );
}

function SlackModeSections({
  userId,
  agentId,
  agentName,
  connectionId,
}: {
  userId: string;
  agentId: string;
  agentName: string;
  connectionId: string;
}) {
  const [dmCode, setDmCode] = useState<string | null>(null);
  const [channelCode, setChannelCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unlinkDm, setUnlinkDm] = useState(false);
  const [channelToUnlink, setChannelToUnlink] = useState<SlackChannelMapping | null>(null);
  const [pending, setPending] = useState(false);

  const { data: linkStatus, refetch: refetchLink } = useApi<SlackLinkStatus>(
    `/agents/slack-link-status?connectionId=${connectionId}`,
    { refetchInterval: dmCode ? 3000 : undefined },
  );
  const { data: channelsResp, refetch: refetchChannels } = useApi<{ channels: SlackChannelMapping[] }>(
    `/agents/slack-channel-mappings?connectionId=${connectionId}`,
    { refetchInterval: channelCode ? 3000 : undefined },
  );

  // Auto-clear codes once the link lands.
  useEffect(() => {
    if (dmCode && linkStatus?.hasDmMapping) setDmCode(null);
  }, [dmCode, linkStatus?.hasDmMapping]);
  const channelCount = channelsResp?.channels.length ?? 0;
  useEffect(() => {
    if (channelCode && channelCount > 0) setChannelCode(null);
  }, [channelCode, channelCount]);

  const createCode = async (type: 'DM' | 'CHANNEL') => {
    setBusy(true);
    try {
      const { code } = await apiPost<{ code: string }>('/agents/slack/create-verification-code', {
        type,
        lensUserId: userId,
        connectionId,
        agentId,
        agentName,
        expiresAt: fifteenMinutesFromNow(),
      });
      if (type === 'DM') setDmCode(code);
      else setChannelCode(code);
    } finally {
      setBusy(false);
    }
  };

  const doUnlinkDm = async () => {
    setPending(true);
    try {
      await apiDelete(`/agents/slack/dm-mapping?connectionId=${connectionId}`);
      setUnlinkDm(false);
      refetchLink();
      refetchChannels();
    } finally {
      setPending(false);
    }
  };

  const doUnlinkChannel = async () => {
    if (!channelToUnlink) return;
    setPending(true);
    try {
      await apiDelete(
        `/agents/slack/channel-mapping/${channelToUnlink.channelId}?connectionId=${connectionId}`,
      );
      setChannelToUnlink(null);
      refetchChannels();
    } finally {
      setPending(false);
    }
  };

  const isPersonalLinked = !!linkStatus?.hasDmMapping;
  const hasLinkedChannel = channelCount > 0;

  const personal = (
    <div className="mode-box">
      <h4 className="mode-title">Personal Mode</h4>
      <p className="mode-desc">Chat privately with this agent via Slack DM.</p>
      {isPersonalLinked ? (
        <div className="linked-row">
          <span>Linked to DM with {linkStatus?.slackUserId ?? 'Slack user'}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setUnlinkDm(true)}>
            Unlink
          </button>
        </div>
      ) : dmCode ? (
        <CodeBlock
          instruction={
            <>
              Send this code to <strong>@{agentName}</strong> in a Slack DM:
            </>
          }
          code={dmCode}
          onRegenerate={() => {
            setDmCode(null);
            refetchLink();
          }}
        />
      ) : (
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => createCode('DM')}>
          {busy ? 'Generating…' : 'Link Account'}
        </button>
      )}
    </div>
  );

  const team = (
    <div className="mode-box">
      <h4 className="mode-title">Team Mode</h4>
      <p className="mode-desc">Invite this agent to Slack channels to help your team.</p>
      {hasLinkedChannel ? (
        <div>
          {channelsResp?.channels.map((ch) => (
            <div key={ch.id} className="linked-row">
              <span className="channel-name">#{ch.channelName || ch.channelId}</span>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setChannelToUnlink(ch)}
              >
                Unlink
              </button>
            </div>
          ))}
        </div>
      ) : channelCode ? (
        <CodeBlock
          instruction={
            <>
              Invite <strong>@{agentName}</strong> to a channel, then enter this code:
            </>
          }
          code={channelCode}
          onRegenerate={() => {
            setChannelCode(null);
            refetchChannels();
          }}
        />
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => createCode('CHANNEL')}
        >
          {busy ? 'Generating…' : 'Get Channel Link Code'}
        </button>
      )}
    </div>
  );

  let content: React.ReactNode;
  if (isPersonalLinked && !hasLinkedChannel) content = personal;
  else if (hasLinkedChannel && !isPersonalLinked) content = team;
  else
    content = (
      <>
        {personal}
        {team}
      </>
    );

  return (
    <div className="mode-sections">
      {content}
      <ConfirmDialog
        isOpen={unlinkDm}
        onClose={() => setUnlinkDm(false)}
        onConfirm={doUnlinkDm}
        isPending={pending}
        entityType="Slack account"
        entityName={linkStatus?.slackUserId ?? 'Slack user'}
        warning="You will no longer receive DM notifications for this agent via Slack."
      />
      <ConfirmDialog
        isOpen={!!channelToUnlink}
        onClose={() => setChannelToUnlink(null)}
        onConfirm={doUnlinkChannel}
        isPending={pending}
        entityType="channel"
        entityName={`#${channelToUnlink?.channelName || channelToUnlink?.channelId || ''}`}
      />
    </div>
  );
}

function CodeBlock({
  instruction,
  code,
  onRegenerate,
}: {
  instruction: React.ReactNode;
  code: string;
  onRegenerate: () => void;
}) {
  return (
    <div className="code-block">
      <p>{instruction}</p>
      <div className="verification-code">{code}</div>
      <p className="mode-desc">Expires in 15 minutes</p>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRegenerate}>
        Generate new code
      </button>
    </div>
  );
}

function HeartbeatTriggersCard({
  userId,
  connectionId,
}: {
  userId: string;
  connectionId: string;
}) {
  const { data: triggers, loading, refetch } = useApi<SlackHeartbeatTrigger[]>(
    `/agents/slack-heartbeat-trigger?userId=${userId}`,
  );
  const [isCreating, setIsCreating] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({ channelId: '', channelName: '', throttleSeconds: 60 });

  const list = triggers ?? [];

  const resetModal = () => {
    setIsCreating(false);
    setForm({ channelId: '', channelName: '', throttleSeconds: 60 });
  };

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      await apiPost<SlackHeartbeatTrigger>('/agents/slack-heartbeat-trigger', {
        connectionId,
        channelId: form.channelId.trim(),
        channelName: form.channelName.trim() || undefined,
        userId,
        throttleSeconds: form.throttleSeconds,
      });
      resetModal();
      refetch();
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await apiDelete(`/agents/slack-heartbeat-trigger/${deleteTarget.id}?userId=${userId}`);
      setDeleteTarget(null);
      refetch();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h3 className="card-title">Heartbeat trigger</h3>
        {list.length === 0 ? (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setIsCreating(true)}>
            <Plus size={16} />
            Add trigger
          </button>
        ) : null}
      </div>

      {loading && !triggers ? (
        <div className="skeleton" style={{ height: '5rem', marginTop: '0.75rem' }} />
      ) : list.length > 0 ? (
        <table className="table" style={{ marginTop: '0.5rem' }}>
          <thead>
            <tr>
              <th>Channel</th>
              <th>Throttle</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((t) => (
              <tr key={t.id}>
                <td>
                  <div className="cell-icon-text">
                    <span className="cell-icon">
                      <Hash size={16} />
                    </span>
                    <span className="cell-strong">
                      {t.slackChannelName ? t.slackChannelName.replace(/^#/, '') : t.slackChannelId}
                    </span>
                  </div>
                </td>
                <td className="cell-muted">{formatDuration(t.throttleSeconds)}</td>
                <td>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label="Delete trigger"
                    onClick={() =>
                      setDeleteTarget({ id: t.id, name: t.slackChannelName ?? t.slackChannelId })
                    }
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className="empty-inline">
          <ScrollText size={40} className="empty-icon" />
          <p className="empty-title">No heartbeat trigger</p>
          <p className="empty-hint">
            When a message arrives in a configured Slack channel, the agent runs a heartbeat with
            those messages as context.
          </p>
        </div>
      )}

      <Modal
        isOpen={isCreating}
        onClose={resetModal}
        title="Add heartbeat trigger"
        onSubmit={handleCreate}
        isSubmitting={submitting}
        submitLabel="Add"
        submitDisabled={!form.channelId.trim()}
      >
        <div className="field">
          <label className="field-label" htmlFor="hb-channel-id">
            Channel ID
          </label>
          <input
            id="hb-channel-id"
            className="input mono"
            value={form.channelId}
            onChange={(e) => setForm((f) => ({ ...f, channelId: e.target.value }))}
            placeholder="C0123ABCD"
          />
          <p className="field-desc">Find the channel ID via Slack channel details.</p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="hb-channel-name">
            Channel name
          </label>
          <input
            id="hb-channel-name"
            className="input"
            value={form.channelName}
            onChange={(e) => setForm((f) => ({ ...f, channelName: e.target.value }))}
            placeholder="alerts"
          />
          <p className="field-desc">Optional, for display only.</p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="hb-throttle">
            Throttle (seconds)
          </label>
          <input
            id="hb-throttle"
            className="input"
            type="number"
            min={0}
            value={form.throttleSeconds}
            onChange={(e) =>
              setForm((f) => ({ ...f, throttleSeconds: parseInt(e.target.value, 10) || 0 }))
            }
          />
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isPending={deleting}
        entityType="heartbeat trigger"
        entityName={`#${(deleteTarget?.name ?? '').replace(/^#/, '')}`}
      />
    </div>
  );
}
