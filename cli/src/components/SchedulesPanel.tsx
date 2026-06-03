import React, { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { ApiClient, ApiError, CronTask } from '../api-client.js';
import { Spinner } from './Spinner.js';

type Mode = 'list' | 'create' | 'confirmDelete';
type LoadState = 'loading' | 'ready' | 'error';

// Fixed-width columns for the list view. Widths include a trailing gap so
// rows line up without an explicit gap prop.
const COL_NAME = 22;
const COL_SCHEDULE = 22;
const COL_NEXT = 22;
const COL_ACTIVE = 8;

// Truncate to fit a column, leaving room for an ellipsis. Cells are rendered
// inside a fixed-width <Box>, but pre-truncating keeps ink from wrapping a
// long value onto a second line and breaking row alignment.
function fit(s: string, width: number): string {
  const max = width - 2;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

// Render nextRunAt as a compact local timestamp, or '—' when unscheduled.
function formatNextRun(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString();
}

interface Props {
  api: ApiClient;
  onClose: () => void;
}

export const SchedulesPanel: React.FC<Props> = ({ api, onClose }) => {
  const [mode, setMode] = useState<Mode>('list');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [tasks, setTasks] = useState<CronTask[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Create-form fields.
  const [formName, setFormName] = useState('');
  const [formSchedule, setFormSchedule] = useState('');
  const [formInstruction, setFormInstruction] = useState('');
  const [focusedField, setFocusedField] = useState<0 | 1 | 2>(0);
  const [submitting, setSubmitting] = useState(false);

  // Shared loader — used on mount, after create/delete, and on retry. The
  // optional `cancelled` ref guards the mount fetch against an unmount race;
  // post-mount callers pass nothing.
  const reload = useCallback(
    async (cancelled?: { current: boolean }) => {
      setLoadState('loading');
      setErrorMsg(null);
      try {
        const list = await api.listCronTasks();
        if (cancelled?.current) return;
        setTasks(list);
        setSelectedIndex((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
        setLoadState('ready');
      } catch (err) {
        if (cancelled?.current) return;
        const message =
          err instanceof ApiError
            ? err.detail ?? err.message
            : err instanceof Error
              ? err.message
              : 'Failed to load schedules';
        setErrorMsg(message);
        setLoadState('error');
      }
    },
    [api],
  );

  useEffect(() => {
    const cancelled = { current: false };
    void reload(cancelled);
    return () => {
      cancelled.current = true;
    };
  }, [reload]);

  const resetForm = useCallback(() => {
    setFormName('');
    setFormSchedule('');
    setFormInstruction('');
    setFocusedField(0);
    setSubmitting(false);
  }, []);

  const submitCreate = useCallback(async () => {
    const name = formName.trim();
    const schedule = formSchedule.trim();
    const instruction = formInstruction.trim();
    if (!name || !schedule || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    try {
      await api.createCronTask({
        name,
        schedule,
        instruction: instruction || undefined,
      });
      resetForm();
      setMode('list');
      await reload();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.detail ?? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to create schedule';
      setErrorMsg(message);
      setSubmitting(false);
    }
  }, [api, formName, formSchedule, formInstruction, submitting, reload, resetForm]);

  const confirmDelete = useCallback(async () => {
    const task = tasks[selectedIndex];
    if (!task) {
      setMode('list');
      return;
    }
    try {
      await api.deleteCronTask(task.id);
      setMode('list');
      await reload();
    } catch (err) {
      const message =
        err instanceof ApiError
          ? err.detail ?? err.message
          : err instanceof Error
            ? err.message
            : 'Failed to delete schedule';
      setErrorMsg(message);
      setLoadState('error');
      setMode('list');
    }
  }, [api, tasks, selectedIndex, reload]);

  // Single useInput for the whole panel, branching by mode. The create-form
  // TextInputs receive focus via their `focus` prop (not useInput), so they
  // coexist with this handler.
  useInput((input, key) => {
    // Error state takes precedence: only retry / close are meaningful.
    if (loadState === 'error') {
      if (input === 'r') {
        void reload();
        return;
      }
      if (key.escape) {
        onClose();
        return;
      }
      return;
    }

    if (loadState === 'loading') return;

    if (mode === 'list') {
      if (key.escape) {
        onClose();
        return;
      }
      if (key.upArrow) {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow) {
        setSelectedIndex((i) => Math.min(Math.max(0, tasks.length - 1), i + 1));
        return;
      }
      if (input === 'n') {
        resetForm();
        setErrorMsg(null);
        setMode('create');
        return;
      }
      if (input === 'd' && tasks.length > 0) {
        setMode('confirmDelete');
        return;
      }
      return;
    }

    if (mode === 'create') {
      if (key.escape) {
        resetForm();
        setErrorMsg(null);
        setMode('list');
        return;
      }
      if (key.return) {
        void submitCreate();
        return;
      }
      if (key.tab && key.shift) {
        setFocusedField((f) => ((f + 2) % 3) as 0 | 1 | 2);
        return;
      }
      if (key.tab || key.downArrow) {
        setFocusedField((f) => ((f + 1) % 3) as 0 | 1 | 2);
        return;
      }
      if (key.upArrow) {
        setFocusedField((f) => ((f + 2) % 3) as 0 | 1 | 2);
        return;
      }
      return;
    }

    if (mode === 'confirmDelete') {
      if (input === 'y') {
        void confirmDelete();
        return;
      }
      if (input === 'n' || key.escape) {
        setMode('list');
        return;
      }
      return;
    }
  });

  if (loadState === 'loading') {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner />
        <Text dimColor> Loading schedules…</Text>
      </Box>
    );
  }

  if (loadState === 'error') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="red">{errorMsg ?? 'Failed to load schedules'}</Text>
        <Text dimColor>press r to retry · esc to close</Text>
      </Box>
    );
  }

  if (mode === 'create') {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">New schedule</Text>
        <Box marginTop={1}>
          <Box width={14}>
            <Text color={focusedField === 0 ? 'cyan' : undefined} bold={focusedField === 0}>
              Name
            </Text>
          </Box>
          <TextInput
            key={focusedField === 0 ? 'name-active' : 'name'}
            value={formName}
            onChange={setFormName}
            focus={focusedField === 0}
          />
        </Box>
        <Box>
          <Box width={14}>
            <Text color={focusedField === 1 ? 'cyan' : undefined} bold={focusedField === 1}>
              Schedule
            </Text>
          </Box>
          <TextInput
            key={focusedField === 1 ? 'schedule-active' : 'schedule'}
            value={formSchedule}
            onChange={setFormSchedule}
            focus={focusedField === 1}
          />
        </Box>
        <Box>
          <Box width={14}>
            <Text color={focusedField === 2 ? 'cyan' : undefined} bold={focusedField === 2}>
              Instruction
            </Text>
          </Box>
          <TextInput
            key={focusedField === 2 ? 'instruction-active' : 'instruction'}
            value={formInstruction}
            onChange={setFormInstruction}
            focus={focusedField === 2}
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Instruction is optional.</Text>
          <Text dimColor>
            Schedule accepts cron or natural language ('every day at 9am', 'in 2 minutes').
          </Text>
        </Box>
        {errorMsg && <Text color="red">{errorMsg}</Text>}
        <Box marginTop={1}>
          {submitting ? (
            <Box>
              <Spinner />
              <Text dimColor> creating…</Text>
            </Box>
          ) : (
            <Text dimColor>tab/↑↓ move · enter create · esc cancel</Text>
          )}
        </Box>
      </Box>
    );
  }

  if (mode === 'confirmDelete') {
    const task = tasks[selectedIndex];
    return (
      <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
        <Text>
          Delete <Text bold>"{task?.name ?? ''}"</Text>? (y/n)
        </Text>
      </Box>
    );
  }

  // mode === 'list'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Schedules</Text>
      <Box marginTop={1}>
        <Box width={2} />
        <Box width={COL_NAME}>
          <Text bold dimColor>NAME</Text>
        </Box>
        <Box width={COL_SCHEDULE}>
          <Text bold dimColor>SCHEDULE</Text>
        </Box>
        <Box width={COL_NEXT}>
          <Text bold dimColor>NEXT RUN</Text>
        </Box>
        <Box width={COL_ACTIVE}>
          <Text bold dimColor>ACTIVE</Text>
        </Box>
      </Box>
      {tasks.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No scheduled tasks. Press n to create one.</Text>
        </Box>
      ) : (
        tasks.map((task, i) => {
          const selected = i === selectedIndex;
          return (
            <Box key={task.id}>
              <Box width={2}>
                <Text color="cyan" bold>{selected ? '▸' : ' '}</Text>
              </Box>
              <Box width={COL_NAME}>
                <Text bold={selected}>{fit(task.name, COL_NAME)}</Text>
              </Box>
              <Box width={COL_SCHEDULE}>
                <Text bold={selected}>{fit(task.schedule, COL_SCHEDULE)}</Text>
              </Box>
              <Box width={COL_NEXT}>
                <Text bold={selected}>{fit(formatNextRun(task.nextRunAt), COL_NEXT)}</Text>
              </Box>
              <Box width={COL_ACTIVE}>
                <Text bold={selected} color={task.isActive ? 'green' : 'red'}>
                  {task.isActive ? '✓' : '✗'}
                </Text>
              </Box>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text dimColor>↑↓ select · n new · d delete · esc close</Text>
      </Box>
    </Box>
  );
};
