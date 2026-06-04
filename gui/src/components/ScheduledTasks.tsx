import { useState } from 'react';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { useApi } from '../hooks/use-api';
import { apiDelete, apiPost, type CronTask } from '../lib/api';
import { Modal } from './ui/Modal';
import { ConfirmDialog } from './ui/ConfirmDialog';

/** Scheduled Tasks (cron) page, ported from web/src/routes/cron.tsx. */
export function ScheduledTasks() {
  const { data: tasks, loading, refetch } = useApi<CronTask[]>('/agents/cron-tasks');
  const [isCreating, setIsCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [form, setForm] = useState({ name: '', schedule: '0 9 * * *', instruction: '' });

  const resetModal = () => {
    setIsCreating(false);
    setForm({ name: '', schedule: '0 9 * * *', instruction: '' });
  };

  const handleCreate = async () => {
    setSubmitting(true);
    try {
      await apiPost<CronTask>('/agents/cron-tasks', {
        name: form.name.trim(),
        schedule: form.schedule.trim(),
        instruction: form.instruction.trim(),
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
      await apiDelete(`/agents/cron-tasks/${deleteTarget.id}`);
      setDeleteTarget(null);
      refetch();
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-title">Scheduled Tasks</h2>
          <p className="page-sub">Recurring agent runs scheduled via cron expressions.</p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setIsCreating(true)}>
          <Plus size={16} />
          New task
        </button>
      </div>

      {loading && !tasks ? (
        <div className="skeleton" style={{ height: '12rem' }} />
      ) : tasks && tasks.length > 0 ? (
        <div className="card" style={{ padding: 0 }}>
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Schedule</th>
                <th>Last run</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tasks.map((t) => (
                <tr key={t.id}>
                  <td>
                    <div className="cell-icon-text">
                      <span className="cell-icon">
                        <Clock size={16} />
                      </span>
                      <span className="cell-strong">{t.name}</span>
                    </div>
                  </td>
                  <td>
                    <code className="code">{t.schedule}</code>
                  </td>
                  <td className="cell-muted">
                    {t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="Delete task"
                      onClick={() => setDeleteTarget({ id: t.id, name: t.name })}
                    >
                      <Trash2 size={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState
          icon={<Clock size={40} />}
          title="No scheduled tasks"
          hint="Create a cron task to run the agent on a schedule."
        />
      )}

      <Modal
        isOpen={isCreating}
        onClose={resetModal}
        title="New cron task"
        onSubmit={handleCreate}
        isSubmitting={submitting}
        submitLabel="Schedule"
        submitDisabled={!form.name.trim() || !form.schedule.trim()}
      >
        <div className="field">
          <label className="field-label" htmlFor="cron-name">
            Name
          </label>
          <input
            id="cron-name"
            className="input"
            value={form.name}
            onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Daily standup summary"
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cron-schedule">
            Schedule
          </label>
          <input
            id="cron-schedule"
            className="input mono"
            value={form.schedule}
            onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))}
            placeholder="0 9 * * *"
          />
          <p className="field-desc">
            Example: <code className="code">0 9 * * *</code> = every day at 09:00.
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cron-instruction">
            Instruction
          </label>
          <textarea
            id="cron-instruction"
            className="input"
            rows={3}
            value={form.instruction}
            onChange={(e) => setForm((f) => ({ ...f, instruction: e.target.value }))}
            placeholder="What should the agent do on each tick?"
          />
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        isPending={deleting}
        entityType="cron task"
        entityName={deleteTarget?.name ?? ''}
      />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  hint,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
}) {
  return (
    <div className="card empty-state">
      <span className="empty-icon">{icon}</span>
      <p className="empty-title">{title}</p>
      <p className="empty-hint">{hint}</p>
    </div>
  );
}
