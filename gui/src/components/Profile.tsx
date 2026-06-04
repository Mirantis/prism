import { useEffect, useState } from 'react';
import {
  Activity,
  Bot,
  Brain,
  Download,
  Eye,
  Heart,
  Pencil,
  Play,
  Power,
  User,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { useApi } from '../hooks/use-api';
import {
  apiPatch,
  apiPost,
  httpUrlExport,
  type AgentDetails,
  type HeartbeatStatus,
  type ModelInfo,
} from '../lib/api';
import { formatInterval, formatRelativeTime } from '../lib/format';

const TABS: { key: keyof AgentDetails; label: string; icon: LucideIcon }[] = [
  { key: 'agentMd', label: 'Agent', icon: Bot },
  { key: 'soulMd', label: 'Soul', icon: Heart },
  { key: 'userMd', label: 'User', icon: User },
  { key: 'heartbeatMd', label: 'Heartbeat', icon: Activity },
  { key: 'memoryMd', label: 'Memory', icon: Brain },
  { key: 'visionMd', label: 'Vision', icon: Eye },
  { key: 'bootstrapMd', label: 'Bootstrap', icon: Wrench },
];

/** Profile page, ported from web/src/routes/profile.tsx. */
export function Profile() {
  const { data: detailsResp, loading, refetch } = useApi<{ agent: AgentDetails }>('/agents/details');
  const details = detailsResp?.agent;
  const [activeTab, setActiveTab] = useState<keyof AgentDetails>('agentMd');

  if (loading && !details) {
    return (
      <div className="page">
        <div className="skeleton" style={{ height: '2rem', width: '12rem' }} />
        <div className="skeleton" style={{ height: '16rem' }} />
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2 className="page-title">Profile</h2>
        <a className="btn btn-ghost" href={httpUrlExport()} download>
          <Download size={16} />
          Export
        </a>
      </div>

      <div className="card">
        <h3 className="card-title">Identity</h3>
        <div className="identity-fields">
          <NameField name={details?.name ?? ''} onSaved={refetch} />
          <ModelField />
        </div>

        {details ? (
          <div className="tabs">
            <div className="tablist">
              {TABS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  type="button"
                  className={`tab${activeTab === key ? ' active' : ''}`}
                  onClick={() => setActiveTab(key)}
                >
                  <Icon size={14} />
                  {label}
                </button>
              ))}
            </div>
            <textarea
              className="input mono markdown-view"
              readOnly
              value={(details[activeTab] as string | null) ?? ''}
              placeholder="(empty)"
            />
          </div>
        ) : (
          <p className="page-sub">Agent details unavailable</p>
        )}
      </div>

      {details ? <StatusPanel details={details} /> : null}
    </div>
  );
}

function NameField({ name, onSaved }: { name: string; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(name);
  }, [name]);

  const valid = value.trim().length > 0 && value.trim().length <= 64;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/agents/name', { name: value.trim() });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rename failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="field-row">
      <span className="field-label">Name</span>
      {editing ? (
        <div className="inline-edit">
          <input
            className="input"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && valid && save()}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || !valid || value.trim() === name}
            onClick={save}
          >
            Save
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setEditing(false);
              setValue(name);
              setError(null);
            }}
          >
            Cancel
          </button>
          {error ? <span className="field-error">{error}</span> : null}
        </div>
      ) : (
        <span className="inline-value">
          {name}
          <button type="button" className="icon-btn" aria-label="Edit name" onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </button>
        </span>
      )}
    </div>
  );
}

function ModelField() {
  const { data, refetch } = useApi<ModelInfo>('/agents/model');
  const effective = data?.model ?? '';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(effective);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setValue(effective);
  }, [effective]);

  const valid = /^[A-Za-z0-9._:\-/]+$/.test(value.trim()) && value.trim().length <= 200;

  const save = async (model: string | null) => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/agents/model', { model });
      setEditing(false);
      refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="field-row">
      <span className="field-label">Model</span>
      {editing ? (
        <div className="inline-edit">
          <input
            className="input mono"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && valid && save(value.trim())}
          />
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={saving || !valid || value.trim() === effective}
            onClick={() => save(value.trim())}
          >
            Save
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => save(null)}>
            Reset
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setEditing(false);
              setValue(effective);
              setError(null);
            }}
          >
            Cancel
          </button>
          {error ? <span className="field-error">{error}</span> : null}
        </div>
      ) : (
        <span className="inline-value mono">
          {effective || '—'}
          <button type="button" className="icon-btn" aria-label="Edit model" onClick={() => setEditing(true)}>
            <Pencil size={14} />
          </button>
        </span>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'RUNNING' ? 'badge-running' : status === 'ERROR' ? 'badge-error' : 'badge-idle';
  return <span className={`badge ${cls}`}>{status}</span>;
}

function StatusPanel({ details }: { details: AgentDetails }) {
  const { data: hb, refetch } = useApi<HeartbeatStatus>('/agents/heartbeat/status', {
    refetchInterval: 5000,
  });
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      refetch();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h3 className="card-title">Heartbeat</h3>
      <div className="hb-grid">
        <Stat label="Status" value={<StatusBadge status={details.status} />} />
        <Stat label="Heartbeat" value={hb ? (hb.isActive ? 'Active' : 'Stopped') : '—'} />
        <Stat label="Interval" value={<IntervalEditor hb={hb} onSaved={refetch} />} />
        <Stat label="Last run" value={hb?.lastRun ? formatRelativeTime(hb.lastRun) : '—'} />
      </div>
      <div className="hb-actions">
        {hb?.isActive ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={busy}
            onClick={() => run(() => apiPost('/agents/heartbeat/stop'))}
          >
            <Power size={16} />
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-sm"
            disabled={busy}
            onClick={() => run(() => apiPost('/agents/heartbeat/start', { agent: details }))}
          >
            <Power size={16} />
            Start
          </button>
        )}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={busy}
          onClick={() => run(() => apiPost('/agents/heartbeat/trigger'))}
        >
          <Play size={16} />
          Trigger now
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <span className="field-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

function IntervalEditor({ hb, onSaved }: { hb: HeartbeatStatus | null; onSaved: () => void }) {
  const intervalMs = hb?.intervalMs ?? null;
  const [editing, setEditing] = useState(false);
  const [mins, setMins] = useState(intervalMs ? Math.round(intervalMs / 60000) : 5);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (intervalMs) setMins(Math.round(intervalMs / 60000));
  }, [intervalMs]);

  const valid = Number.isFinite(mins) && mins >= 1 && mins <= 10080;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiPatch('/agents/heartbeat/interval', { intervalMs: mins * 60000 });
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <span className="inline-value">
        {intervalMs == null ? '—' : `Every ${formatInterval(intervalMs)}`}
        <button type="button" className="icon-btn" aria-label="Edit interval" onClick={() => setEditing(true)}>
          <Pencil size={14} />
        </button>
      </span>
    );
  }

  return (
    <span className="inline-edit">
      <input
        className="input"
        type="number"
        min={1}
        max={10080}
        value={mins}
        autoFocus
        style={{ width: '5rem' }}
        onChange={(e) => setMins(parseInt(e.target.value, 10))}
        onKeyDown={(e) => e.key === 'Enter' && valid && save()}
      />
      <span className="field-label">min</span>
      <button type="button" className="btn btn-primary btn-sm" disabled={saving || !valid} onClick={save}>
        Save
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error ? <span className="field-error">{error}</span> : null}
    </span>
  );
}
