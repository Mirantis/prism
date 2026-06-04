import {
  Activity,
  Bot,
  Clock,
  MessageSquare,
  MessagesSquare,
  type LucideIcon,
} from 'lucide-react';
import { useApi } from '../hooks/use-api';
import { formatInterval, formatRelativeTime } from '../lib/format';
import type {
  AgentDetails,
  AgentSummary,
  CronTask,
  HeartbeatStatus,
  SlackChannelMapping,
  SlackLinkStatus,
  SlackWorkspace,
} from '../lib/api';
import type { ViewId } from './AppSidebar';

/**
 * Overview / home page, ported from web/src/routes/index.tsx. Stat cards whose
 * web counterparts navigate to pages the GUI doesn't have yet (profile,
 * channels, cron) render as read-only info cards for now.
 */
export function Overview({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  const { data: me } = useApi<AgentSummary>('/agents/me');
  const { data: detailsResp, loading } = useApi<{ agent: AgentDetails }>('/agents/details');
  const agent = detailsResp?.agent;
  const name = me?.name ?? agent?.name ?? 'Agent';

  if (loading && !agent) {
    return (
      <div className="overview">
        <div className="skeleton" style={{ height: '2rem', width: '16rem' }} />
        <div className="ov-grid">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: '7rem' }} />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="overview">
      <div className="ov-header">
        <div>
          <h2 className="ov-title">{name}</h2>
          <div className="ov-badges">
            {agent ? <span className="badge badge-secondary mono">{agent.agentType}</span> : null}
            {agent ? <StatusBadge status={agent.status} /> : null}
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => onNavigate('chat')}>
          <MessageSquare size={16} />
          Chat
        </button>
      </div>

      <div className="ov-grid">
        <HeartbeatCard onClick={() => onNavigate('profile')} />
        <ChannelsCard onClick={() => onNavigate('channels')} />
        <ScheduledTasksCard onClick={() => onNavigate('cron')} />
        <CreatedCard details={agent} />
      </div>

      <WelcomeCard onNavigate={onNavigate} />
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'RUNNING' ? 'badge-running' : status === 'ERROR' ? 'badge-error' : 'badge-idle';
  return <span className={`badge ${cls}`}>{status}</span>;
}

interface StatCardProps {
  label: string;
  icon: LucideIcon;
  loading?: boolean;
  value: React.ReactNode;
  sub?: React.ReactNode;
  onClick?: () => void;
}

function StatCard({ label, icon: Icon, loading, value, sub, onClick }: StatCardProps) {
  return (
    <div className={`card${onClick ? ' card-clickable' : ''}`} onClick={onClick}>
      <div className="card-head">
        <span className="card-label">{label}</span>
        <Icon size={16} className="card-icon" />
      </div>
      {loading ? (
        <div className="skeleton" style={{ height: '1.75rem', width: '5rem', marginTop: '0.5rem' }} />
      ) : (
        <>
          <div className="card-value">{value}</div>
          {sub != null ? <p className="card-sub">{sub}</p> : null}
        </>
      )}
    </div>
  );
}

function HeartbeatCard({ onClick }: { onClick: () => void }) {
  const { data, loading } = useApi<HeartbeatStatus>('/agents/heartbeat/status', {
    refetchInterval: 30_000,
  });
  return (
    <StatCard
      label="Heartbeat"
      icon={Activity}
      onClick={onClick}
      loading={loading && !data}
      value={data?.isActive ? 'Active' : 'Stopped'}
      sub={
        <>
          {data?.intervalMs ? `Every ${formatInterval(data.intervalMs)}` : '—'}
          {data?.lastRun ? ` · ${formatRelativeTime(data.lastRun)}` : ''}
        </>
      }
    />
  );
}

function ChannelsCard({ onClick }: { onClick: () => void }) {
  const { data: ws, loading } = useApi<{ workspaces: SlackWorkspace[] }>('/agents/slack/workspaces');
  const workspace = ws?.workspaces[0];
  const teamId = workspace?.teamId ?? null;

  const { data: linkStatus } = useApi<SlackLinkStatus>(
    teamId ? `/agents/slack-link-status?connectionId=${teamId}` : null,
  );
  const { data: channels } = useApi<{ channels: SlackChannelMapping[] }>(
    teamId ? `/agents/slack-channel-mappings?connectionId=${teamId}` : null,
  );

  const count = channels?.channels.length ?? 0;
  const subtitle = !workspace
    ? 'Not configured'
    : `${workspace.teamName}${linkStatus?.hasDmMapping ? ' · DM linked' : ''}`;

  return (
    <StatCard
      label="Channels"
      icon={MessagesSquare}
      onClick={onClick}
      loading={loading && !ws}
      value={count}
      sub={subtitle}
    />
  );
}

function ScheduledTasksCard({ onClick }: { onClick: () => void }) {
  const { data: tasks, loading } = useApi<CronTask[]>('/agents/cron-tasks');
  const activeTasks = tasks?.filter((t) => t.isActive) ?? [];
  const nextRun = nextRunAt(activeTasks);
  const subtitle =
    !tasks || tasks.length === 0
      ? 'No tasks scheduled'
      : nextRun
        ? `Next run ${formatRelativeTime(nextRun)}`
        : `${activeTasks.length} active`;

  return (
    <StatCard
      label="Scheduled Tasks"
      icon={Clock}
      onClick={onClick}
      loading={loading && !tasks}
      value={tasks?.length ?? 0}
      sub={subtitle}
    />
  );
}

function CreatedCard({ details }: { details: AgentDetails | undefined }) {
  return (
    <StatCard
      label="Created"
      icon={Clock}
      loading={!details}
      value={details ? new Date(details.createdAt).toLocaleDateString() : ''}
      sub={details ? `Updated ${formatRelativeTime(details.updatedAt)}` : undefined}
    />
  );
}

function nextRunAt(tasks: CronTask[]): string | null {
  const times = tasks
    .map((t) => t.nextRunAt)
    .filter((v): v is string => !!v)
    .map((v) => ({ raw: v, ts: new Date(v).getTime() }))
    .filter((v) => Number.isFinite(v.ts) && v.ts >= Date.now());
  if (times.length === 0) return null;
  times.sort((a, b) => a.ts - b.ts);
  return times[0].raw;
}

function WelcomeCard({ onNavigate }: { onNavigate: (view: ViewId) => void }) {
  return (
    <div className="card welcome">
      <h3 className="card-title">Welcome to Prism</h3>
      <p className="card-desc">
        Your autonomous agent — it learns, remembers, and operates on its own. Defined by you, not
        by us.
      </p>
      <div className="welcome-tiles">
        <ActionTile
          icon={MessageSquare}
          title="Start a conversation"
          description="Train your agent through chat — tell it what to monitor and how to act."
          onClick={() => onNavigate('chat')}
        />
        <ActionTile
          icon={MessagesSquare}
          title="Link it to Slack"
          description="DM your agent or wire it up to watch a channel."
          onClick={() => onNavigate('channels')}
        />
        <ActionTile
          icon={Clock}
          title="Schedule recurring tasks"
          description="Run cron-driven checks and reports on your schedule."
          onClick={() => onNavigate('cron')}
        />
        <ActionTile
          icon={Bot}
          title="Customize its personality"
          description="Edit identity, heartbeat, memory and vision in plain markdown."
          onClick={() => onNavigate('profile')}
        />
      </div>
    </div>
  );
}

function ActionTile({
  icon: Icon,
  title,
  description,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  onClick?: () => void;
}) {
  const content = (
    <>
      <Icon size={20} className="tile-icon" />
      <div>
        <div className="tile-title">{title}</div>
        <div className="tile-desc">{description}</div>
      </div>
    </>
  );
  // Tiles with no destination yet render as static onboarding hints.
  if (!onClick) return <div className="tile">{content}</div>;
  return (
    <button type="button" className="tile" onClick={onClick}>
      {content}
    </button>
  );
}
