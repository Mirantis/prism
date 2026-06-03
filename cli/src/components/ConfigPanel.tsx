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
  const lines = useMemo(
    () => (rawContent.trim().length === 0 ? [] : renderMarkdown(rawContent).split('\n')),
    [rawContent],
  );

  // Reset the scroll position whenever the selected doc changes so a new doc
  // always opens at its top.
  useEffect(() => {
    setScrollOffset(0);
  }, [selected]);

  const windowSize = Math.max(8, (process.stdout.rows ?? 24) - 8);
  const maxOffset = Math.max(0, lines.length - windowSize);
  const offset = Math.min(scrollOffset, maxOffset);
  const visibleLines = lines.slice(offset, offset + windowSize);

  // Single useInput for the whole panel. Tab / left / right swap panes; the
  // arrow keys then act on whichever pane is focused. 'r' retries on error,
  // escape always closes.
  useInput((input, key) => {
    if (key.escape) {
      onClose();
      return;
    }
    if (error) {
      if (input === 'r') setReloadKey((k) => k + 1);
      return;
    }
    if (key.tab || key.leftArrow || key.rightArrow) {
      setPane((p) => (p === 'list' ? 'content' : 'list'));
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

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Box flexDirection="column" width={24} marginRight={2}>
          <Text bold>{details.name}</Text>
          <Text dimColor>Model {details.model ?? 'default'}</Text>
          <Text dimColor>Proactivity {details.proactivity}</Text>
          <Text dimColor>Verbosity {details.verbosity}</Text>
          <Text dimColor>Timezone {details.timezone}</Text>
          <Text dimColor>{`Heartbeat ${details.heartbeatStatus} ${heartbeatEvery}`}</Text>
          <Box marginTop={1} flexDirection="column">
            {DOCS.map((doc, i) => {
              const isSelected = i === selected;
              return (
                <Text key={doc.field} color={isSelected ? 'cyan' : undefined}>
                  {isSelected ? '▸ ' : '  '}
                  {doc.label}
                </Text>
              );
            })}
          </Box>
        </Box>
        <Box flexGrow={1} flexDirection="column">
          {lines.length === 0 ? (
            <Text dimColor>(empty)</Text>
          ) : (
            visibleLines.map((line, i) => <Text key={offset + i}>{line}</Text>)
          )}
        </Box>
      </Box>
      <Text dimColor>tab switch pane · ↑↓ scroll · esc close</Text>
    </Box>
  );
};
