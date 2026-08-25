import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { ApiClient, AgentDetails } from '../api-client.js';
import { renderMarkdown } from '../markdown.js';
import { Spinner } from './Spinner.js';

// The seven workspace docs, in display order, paired with friendly labels and
// the AgentDetails field each maps to. Selecting one renders its markdown in
// the right column.
const DOCS: { label: string; field: keyof AgentDetails }[] = [
  { label: 'Soul', field: 'soulMd' },
  { label: 'User', field: 'userMd' },
  { label: 'Memory', field: 'memoryMd' },
  { label: 'Heartbeat', field: 'heartbeatMd' },
  { label: 'Vision', field: 'visionMd' },
  { label: 'Agent', field: 'agentMd' },
  { label: 'Bootstrap', field: 'bootstrapMd' },
];

type Pane = 'list' | 'content';

export const ConfigPanel: React.FC<{ api: ApiClient; onClose: () => void }> = ({ api, onClose }) => {
  const [details, setDetails] = useState<AgentDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Bumped to re-run the load effect on 'r' after a failure.
  const [reloadKey, setReloadKey] = useState(0);

  const [selected, setSelected] = useState(0);
  const [pane, setPane] = useState<Pane>('list');
  const [scrollOffset, setScrollOffset] = useState(0);

  // Fetch the full agent record once per (re)load. The cancelled guard keeps a
  // late-resolving fetch from writing into an unmounted component's state.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void api
      .getDetails()
      .then((d) => {
        if (cancelled) return;
        setDetails(d);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [api, reloadKey]);

  // Render the selected doc to terminal markdown, then split into lines so we
  // can window it manually — Ink has no native scrolling.
  const selectedField = DOCS[selected]!.field;
  const rawContent = details ? String(details[selectedField] ?? '') : '';
  // Left pane is 24 cols + 2 cols marginRight; outer paddingX={1} consumes 2 cols.
  const contentWidth = Math.max(40, (process.stdout.columns ?? 100) - 24 - 2 - 2);
  const lines = useMemo(
    () => (rawContent.trim().length === 0 ? [] : renderMarkdown(rawContent, contentWidth).split('\n')),
    [rawContent, contentWidth],
  );

  // Reset the scroll position whenever the selected doc changes so a new doc
  // always opens at its top.
  useEffect(() => {
    setScrollOffset(0);
  }, [selected]);

  // Leave headroom for the outer header, the per-pane headers, and the footer.
  const windowSize = Math.max(8, (process.stdout.rows ?? 24) - 10);
  const maxOffset = Math.max(0, lines.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const visibleLines = lines.slice(offset, offset + windowSize);

  // Single useInput for the whole panel. The focused pane (shown by the ▌ bar
  // in the headers) decides what ↑/↓ act on. Tab toggles panes; → moves into
  // the content, ← back to the file list — directional so they match the
  // on-screen focus marker. 'r' retries on error, escape always closes.
  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (error) {
      if (input === 'r') setReloadKey((k) => k + 1);
      return;
    }
    if (key.tab) {
      setPane((p) => (p === 'list' ? 'content' : 'list'));
      return;
    }
    if (key.rightArrow) {
      setPane('content');
      return;
    }
    if (key.leftArrow) {
      setPane('list');
      return;
    }
    if (pane === 'list') {
      if (key.upArrow) {
        setSelected((i) => Math.max(0, i - 1));
      } else if (key.downArrow) {
        setSelected((i) => Math.min(DOCS.length - 1, i + 1));
      }
      return;
    }
    // pane === 'content'
    if (key.upArrow) {
      setScrollOffset((o) => Math.max(0, o - 1));
    } else if (key.downArrow) {
      setScrollOffset((o) => Math.min(maxOffset, o + 1));
    } else if (key.pageUp) {
      setScrollOffset((o) => Math.max(0, o - windowSize));
    } else if (key.pageDown) {
      setScrollOffset((o) => Math.min(maxOffset, o + windowSize));
    }
  });

  if (loading) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Spinner />
        <Text> Loading config…</Text>
      </Box>
    );
  }

  if (error || !details) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text color="red">{error ?? 'Failed to load config'}</Text>
        <Text dimColor>press r to retry · esc to close</Text>
      </Box>
    );
  }

  const heartbeatEvery = `every ${Math.round(details.heartbeatIntervalMs / 60000)}m`;
  const listFocused = pane === 'list';
  // Show the scroll window in the content header when the doc overflows, e.g.
  // "1–24 / 120", so it's obvious there's more below the fold.
  const scrollInfo =
    lines.length > windowSize
      ? `  ${offset + 1}–${Math.min(offset + windowSize, lines.length)} / ${lines.length}`
      : '';

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Box flexDirection="column" width={24} marginRight={2}>
          <Text bold>{details.name}</Text>
          <Text dimColor>Model {details.model ?? 'default'}</Text>
          <Text dimColor>Heartbeat model {details.heartbeatModel ?? '(main)'}</Text>
          <Text dimColor>Cron model {details.cronModel ?? '(main)'}</Text>
          <Text dimColor>Timezone {details.timezone}</Text>
          <Text dimColor>{`Heartbeat ${details.heartbeatStatus} ${heartbeatEvery}`}</Text>
          <Box marginTop={1} flexDirection="column">
            {/* The ▌ bar marks the focused pane; the list dims when it isn't. */}
            <Text bold color={listFocused ? 'cyan' : undefined} dimColor={!listFocused}>
              {listFocused ? '▌ ' : '  '}Files
            </Text>
            {DOCS.map((doc, i) => {
              const isSelected = i === selected;
              return (
                <Text
                  key={doc.field}
                  color={isSelected && listFocused ? 'cyan' : undefined}
                  bold={isSelected && listFocused}
                  dimColor={!listFocused}
                >
                  {isSelected ? '▸ ' : '  '}
                  {doc.label}
                </Text>
              );
            })}
          </Box>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          <Text bold color={listFocused ? undefined : 'cyan'} dimColor={listFocused}>
            {listFocused ? '  ' : '▌ '}
            {DOCS[selected]!.label}
            {scrollInfo}
          </Text>
          {lines.length === 0 ? (
            <Text dimColor>(empty)</Text>
          ) : (
            visibleLines.map((line, i) => <Text key={offset + i}>{line}</Text>)
          )}
        </Box>
      </Box>
      <Text dimColor>
        {listFocused
          ? '↑↓ select · →/tab content · esc close'
          : '↑↓ scroll · ←/tab files · esc close'}
        {DOCS[selected]!.field === 'agentMd' ? ' · esc then /agent-guide to edit' : ''}
      </Text>
    </Box>
  );
};
