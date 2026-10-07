import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { TextInput } from './TextInput.js';
import { Spinner } from './Spinner.js';
import {
  ApiClient,
  ApiError,
  SlackChannel,
  WebhookDeliverTo,
  WebhookSubscription,
  WebhookSubscriptionUpdate,
} from '../api-client.js';
import { editText, resolveEditor, type EditResult } from '../editor.js';

type Mode = 'list' | 'edit';
type LoadState = 'loading' | 'ready' | 'error';

const DELIVER_TARGETS: WebhookDeliverTo[] = ['all', 'chat', 'slack', 'teams', 'none'];
const DELIVER_LABELS: Record<WebhookDeliverTo, string> = {
  all: 'All channels',
  chat: 'Chat',
  slack: 'Slack',
  teams: 'Microsoft Teams',
  none: 'None',
};

/** A target that a newer runtime added shows as its stored value. */
function deliverLabel(target: string): string {
  return (DELIVER_LABELS as Partial<Record<string, string>>)[target] ?? target;
}

/** An edit form row. A Slack channel row is named for its channel id. */
type Field = 'description' | 'events' | 'deliverTo' | 'deliverOnly' | 'prompt' | `channel:${string}`;

/** One checkbox row of the Slack channel list. */
interface ChannelOption {
  id: string;
  label: string;
  isMain: boolean;
  isLinked: boolean;
}

/**
 * The linked channels, then each chosen channel that was unlinked since, so
 * the user can see it and clear it.
 */
function channelOptions(linked: SlackChannel[], chosen: string[]): ChannelOption[] {
  return [
    ...linked.map((c) => ({ id: c.channelId, label: `#${c.channelName ?? c.channelId}`, isMain: c.isMain, isLinked: true })),
    ...chosen
      .filter((id) => !linked.some((c) => c.channelId === id))
      .map((id) => ({ id, label: id, isMain: false, isLinked: false })),
  ];
}

/** The edit form's rows in focus order. Channel rows show for the Slack target only. */
function fieldOrder(deliverTo: string, options: ChannelOption[]): Field[] {
  const channels = deliverTo === 'slack' ? options.map((o): Field => `channel:${o.id}`) : [];
  return ['description', 'events', 'deliverTo', ...channels, 'deliverOnly', 'prompt'];
}

/** The row `step` rows away from `field`, wrapping at either end. */
function stepField(order: Field[], field: Field, step: 1 | -1): Field {
  return order[(order.indexOf(field) + step + order.length) % order.length]!;
}

const LABEL_WIDTH = 16;
const PROMPT_PREVIEW_LINES = 4;

// Fixed-width list columns; each width includes a trailing gap.
const COL_NAME = 26;
const COL_DELIVER = 18;
const COL_MODE = 10;

interface Form {
  description: string;
  events: string;
  deliverTo: string;
  slackChannelIds: string[];
  deliverOnly: boolean;
  prompt: string;
}

function formFrom(s: WebhookSubscription): Form {
  return {
    description: s.description ?? '',
    events: s.events ?? '',
    deliverTo: s.deliverTo,
    slackChannelIds: s.slackChannelIds ?? [],
    deliverOnly: s.deliverOnly,
    prompt: s.prompt ?? '',
  };
}

function fit(s: string, width: number): string {
  const max = width - 2;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return err.detail ?? err.message;
  if (err instanceof Error) return err.message;
  return fallback;
}

interface Props {
  api: ApiClient;
  onClose: () => void;
  /** Hands the terminal to a child process (the editor) and takes it back. */
  suspendInput: <T>(fn: () => Promise<T>) => Promise<T>;
  /** False while another panel covers this one. */
  inputActive?: boolean;
}

/**
 * Lists webhook subscriptions, pauses and resumes them, and edits everything
 * but the name and the sender authentication. The prompt is multi-line, so it
 * is edited in `$EDITOR`; the other fields are edited in place.
 */
export const WebhooksPanel: React.FC<Props> = ({ api, onClose, suspendInput, inputActive = true }) => {
  const [mode, setMode] = useState<Mode>('list');
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [subscriptions, setSubscriptions] = useState<WebhookSubscription[]>([]);
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [toggling, setToggling] = useState(false);

  const [form, setForm] = useState<Form | null>(null);
  const [focused, setFocused] = useState<Field>('description');
  const [submitting, setSubmitting] = useState(false);
  // True while the editor owns the terminal. Every input hook here is then inactive.
  const [handingOff, setHandingOff] = useState(false);
  const listening = inputActive && !handingOff;
  // The temp file of the last prompt edit. Closing the form removes it; a failed
  // save names it and leaves it to the user.
  const promptFile = useRef<EditResult | null>(null);

  const reload = useCallback(
    async (cancelled?: { current: boolean }) => {
      setLoadState('loading');
      setErrorMsg(null);
      try {
        const [list, channels] = await Promise.all([api.listWebhookSubscriptions(), api.listSlackChannels()]);
        if (cancelled?.current) return;
        setSubscriptions(list);
        setSlackChannels(channels);
        setSelectedIndex((i) => (list.length === 0 ? 0 : Math.min(i, list.length - 1)));
        setLoadState('ready');
      } catch (err) {
        if (cancelled?.current) return;
        setErrorMsg(errorText(err, 'Failed to load webhooks'));
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

  const selected = subscriptions[selectedIndex];
  const options = channelOptions(slackChannels, selected?.slackChannelIds ?? []);
  const order = fieldOrder(form?.deliverTo ?? '', options);

  const replaceSubscription = useCallback((updated: WebhookSubscription) => {
    setSubscriptions((list) => list.map((s) => (s.id === updated.id ? updated : s)));
  }, []);

  const toggleSelected = useCallback(async () => {
    if (!selected || toggling) return;
    setToggling(true);
    setErrorMsg(null);
    try {
      replaceSubscription(
        await api.updateWebhookSubscription(selected.id, { isActive: !selected.isActive }),
      );
    } catch (err) {
      setErrorMsg(errorText(err, 'Failed to update the webhook'));
    } finally {
      setToggling(false);
    }
  }, [api, selected, toggling, replaceSubscription]);

  const openEdit = useCallback(() => {
    if (!selected) return;
    setForm(formFrom(selected));
    setFocused('description');
    setErrorMsg(null);
    setMode('edit');
  }, [selected]);

  const closeEdit = useCallback(() => {
    promptFile.current?.discard();
    promptFile.current = null;
    setForm(null);
    setSubmitting(false);
    setErrorMsg(null);
    setMode('list');
  }, []);

  const save = useCallback(async () => {
    if (!selected || !form || submitting) return;
    setSubmitting(true);
    setErrorMsg(null);
    // An empty string clears the stored value.
    const update: WebhookSubscriptionUpdate = {
      description: form.description.trim(),
      events: form.events.trim(),
      prompt: form.prompt.trim(),
      deliverTo: form.deliverTo,
      // The runtime accepts a channel list for the Slack target only.
      slackChannelIds: form.deliverTo === 'slack' ? form.slackChannelIds : [],
      deliverOnly: form.deliverOnly,
    };
    try {
      replaceSubscription(await api.updateWebhookSubscription(selected.id, update));
      closeEdit();
    } catch (err) {
      const message = errorText(err, 'Failed to save the webhook');
      const kept = promptFile.current;
      promptFile.current = null;
      setErrorMsg(kept ? `${message}\nYour edit is kept at ${kept.file}` : message);
      setSubmitting(false);
    }
  }, [api, selected, form, submitting, replaceSubscription, closeEdit]);

  const editPrompt = useCallback(async () => {
    if (!form) return;
    setHandingOff(true);
    setErrorMsg(null);
    try {
      const result = await suspendInput(() => editText(form.prompt, { suffix: '.md' }));
      if (result.changed) {
        // The new file holds the previous edit too.
        promptFile.current?.discard();
        promptFile.current = result;
        setForm((f) => (f ? { ...f, prompt: result.text.trim() } : f));
      }
    } catch (err) {
      setErrorMsg(`Could not open ${resolveEditor()}: ${errorText(err, 'unknown error')}`);
    } finally {
      setHandingOff(false);
    }
  }, [form, suspendInput]);

  const cycleDeliverTo = useCallback((step: 1 | -1) => {
    setForm((f) => {
      if (!f) return f;
      const i = (DELIVER_TARGETS as string[]).indexOf(f.deliverTo);
      const next = DELIVER_TARGETS[(i + step + DELIVER_TARGETS.length) % DELIVER_TARGETS.length]!;
      // Deliver only posts the template, so it needs a target.
      return { ...f, deliverTo: next, deliverOnly: next === 'none' ? false : f.deliverOnly };
    });
  }, []);

  const toggleChannel = useCallback((id: string) => {
    setForm((f) => {
      if (!f) return f;
      const chosen = f.slackChannelIds.includes(id);
      return { ...f, slackChannelIds: chosen ? f.slackChannelIds.filter((c) => c !== id) : [...f.slackChannelIds, id] };
    });
  }, []);

  // One handler for the whole panel, branching by mode. The form's TextInputs
  // take keys through their own `focus` prop and coexist with it.
  useInput(
    (input, key) => {
      if (loadState === 'error') {
        if (input === 'r') void reload();
        else if (key.escape) onClose();
        return;
      }
      if (loadState === 'loading') return;

      if (mode === 'list') {
        if (key.escape) {
          onClose();
        } else if (key.upArrow) {
          setSelectedIndex((i) => Math.max(0, i - 1));
        } else if (key.downArrow) {
          setSelectedIndex((i) => Math.min(Math.max(0, subscriptions.length - 1), i + 1));
        } else if (key.return) {
          openEdit();
        } else if (input === ' ') {
          void toggleSelected();
        }
        return;
      }

      // mode === 'edit'
      if (submitting) return;
      if (key.escape) {
        closeEdit();
        return;
      }
      if (key.return) {
        void save();
        return;
      }
      if ((key.tab && key.shift) || key.upArrow) {
        setFocused((f) => stepField(order, f, -1));
        return;
      }
      if (key.tab || key.downArrow) {
        setFocused((f) => stepField(order, f, 1));
        return;
      }
      if (focused === 'deliverTo') {
        if (key.leftArrow) cycleDeliverTo(-1);
        else if (key.rightArrow || input === ' ') cycleDeliverTo(1);
      } else if (focused.startsWith('channel:') && input === ' ') {
        toggleChannel(focused.slice('channel:'.length));
      } else if (focused === 'deliverOnly' && input === ' ') {
        setForm((f) => (f && f.deliverTo !== 'none' ? { ...f, deliverOnly: !f.deliverOnly } : f));
      } else if (focused === 'prompt' && input === ' ') {
        void editPrompt();
      }
    },
    { isActive: listening },
  );

  if (loadState === 'loading') {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner />
        <Text dimColor> Loading webhooks…</Text>
      </Box>
    );
  }

  if (loadState === 'error') {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="red">{errorMsg ?? 'Failed to load webhooks'}</Text>
        <Text dimColor>press r to retry · esc to close</Text>
      </Box>
    );
  }

  if (mode === 'edit' && form && selected) {
    const label = (field: Field, text: string) => (
      <Box width={LABEL_WIDTH}>
        <Text color={focused === field ? 'cyan' : undefined} bold={focused === field}>
          {text}
        </Text>
      </Box>
    );
    const promptLines = form.prompt ? form.prompt.split('\n') : [];
    const hiddenLines = promptLines.length - PROMPT_PREVIEW_LINES;
    const keyHint =
      focused === 'deliverTo'
        ? '←→ change'
        : focused === 'deliverOnly' || focused.startsWith('channel:')
          ? 'space toggle'
          : focused === 'prompt'
            ? 'space open in editor'
            : null;

    return (
      <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
        <Text bold color="cyan">
          Edit webhook {selected.name}
        </Text>
        <Box marginTop={1}>
          {label('description', 'Description')}
          <TextInput
            key={focused === 'description' ? 'description-active' : 'description'}
            value={form.description}
            onChange={(description) => setForm((f) => (f ? { ...f, description } : f))}
            focus={listening && focused === 'description'}
          />
        </Box>
        <Box>
          {label('events', 'Events')}
          <TextInput
            key={focused === 'events' ? 'events-active' : 'events'}
            value={form.events}
            onChange={(events) => setForm((f) => (f ? { ...f, events } : f))}
            focus={listening && focused === 'events'}
          />
        </Box>
        <Box>
          {label('deliverTo', 'Deliver to')}
          <Text>‹ {deliverLabel(form.deliverTo)} ›</Text>
        </Box>
        {form.deliverTo === 'slack' && options.length === 0 && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text>Slack channels</Text>
            </Box>
            <Text dimColor>none linked: posts to your DM, else the main channel</Text>
          </Box>
        )}
        {form.deliverTo === 'slack' &&
          options.map((option, i) => (
            <Box key={option.id}>
              {i === 0 ? label(`channel:${option.id}`, 'Slack channels') : <Box width={LABEL_WIDTH} />}
              <Text
                color={focused === `channel:${option.id}` ? 'cyan' : undefined}
                bold={focused === `channel:${option.id}`}
              >
                {form.slackChannelIds.includes(option.id) ? '[x]' : '[ ]'} {option.label}
              </Text>
              {option.isMain && <Text dimColor> main</Text>}
              {!option.isLinked && <Text dimColor> not linked</Text>}
            </Box>
          ))}
        <Box>
          {label('deliverOnly', 'Deliver only')}
          <Text dimColor={form.deliverTo === 'none'}>
            {form.deliverOnly ? '[x]' : '[ ]'} Skip the agent, deliver the template directly
          </Text>
        </Box>
        <Box>
          {label('prompt', form.deliverOnly ? 'Template' : 'Prompt')}
          <Box flexDirection="column">
            {promptLines.length === 0 ? (
              <Text dimColor>(empty: the raw payload)</Text>
            ) : (
              // Ink draws an empty Text at no height, so a blank line keeps a space.
              promptLines.slice(0, PROMPT_PREVIEW_LINES).map((line, i) => <Text key={i}>{line || ' '}</Text>)
            )}
            {hiddenLines > 0 && (
              <Text dimColor>
                … {hiddenLines} more {hiddenLines === 1 ? 'line' : 'lines'}
              </Text>
            )}
          </Box>
        </Box>
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>
            Events is a comma-separated allowlist; empty accepts every event. Prompts substitute
            {' {field.path} and {__raw__}.'}
          </Text>
          {form.deliverTo === 'slack' && options.length > 0 && (
            <Text dimColor>With no Slack channel checked, Slack delivery goes to your DM, else the main channel.</Text>
          )}
        </Box>
        {errorMsg && <Text color="red">{errorMsg}</Text>}
        <Box marginTop={1}>
          {submitting ? (
            <Box>
              <Spinner />
              <Text dimColor> saving…</Text>
            </Box>
          ) : (
            <Text dimColor>
              tab/↑↓ move{keyHint ? ` · ${keyHint}` : ''} · enter save · esc cancel
            </Text>
          )}
        </Box>
      </Box>
    );
  }

  // mode === 'list'
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text bold color="cyan">Webhooks</Text>
      <Box marginTop={1}>
        <Box width={2} />
        <Box width={COL_NAME}>
          <Text bold dimColor>NAME</Text>
        </Box>
        <Box width={COL_DELIVER}>
          <Text bold dimColor>DELIVER TO</Text>
        </Box>
        <Box width={COL_MODE}>
          <Text bold dimColor>MODE</Text>
        </Box>
        <Text bold dimColor>ACTIVE</Text>
      </Box>
      {subscriptions.length === 0 ? (
        <Box marginTop={1}>
          <Text dimColor>No webhook subscriptions. Create one on the Web UI's Webhooks page.</Text>
        </Box>
      ) : (
        subscriptions.map((s, i) => {
          const isSelected = i === selectedIndex;
          return (
            <Box key={s.id}>
              <Box width={2}>
                <Text color="cyan" bold>{isSelected ? '▸' : ' '}</Text>
              </Box>
              <Box width={COL_NAME}>
                <Text bold={isSelected}>{fit(s.name, COL_NAME)}</Text>
              </Box>
              <Box width={COL_DELIVER}>
                <Text bold={isSelected}>{fit(deliverLabel(s.deliverTo), COL_DELIVER)}</Text>
              </Box>
              <Box width={COL_MODE}>
                <Text bold={isSelected}>{s.deliverOnly ? 'direct' : 'agent'}</Text>
              </Box>
              <Text bold={isSelected} color={s.isActive ? 'green' : 'red'}>
                {s.isActive ? '✓' : '✗'}
              </Text>
            </Box>
          );
        })
      )}
      {errorMsg && <Text color="red">{errorMsg}</Text>}
      <Box marginTop={1}>
        <Text dimColor>
          {subscriptions.length === 0
            ? 'esc close'
            : '↑↓ select · enter edit · space pause/resume · esc close'}
        </Text>
      </Box>
    </Box>
  );
};
