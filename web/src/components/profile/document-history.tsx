import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  GitCompareArrows,
  History,
  RotateCcw,
} from 'lucide-react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError, type AgentDetails, type DocumentRevisionSummary } from '@lensapp/prism-client';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { cn } from '@/lib/utils';
import { revisionTitle } from '@/lib/revision-labels';
import { RevisionDiff } from './revision-diff';
import { RevisionListItem } from './revision-list-item';

const LIVE = 'live';

function useSideContent(field: string, side: string, live: string) {
  const query = useQuery({
    queryKey: ['document-revision', field, side],
    queryFn: () => runtimeApi.documentRevision(field, side),
    enabled: side !== LIVE,
  });
  return side === LIVE
    ? { content: live, ready: true, error: null }
    : {
        content: query.data?.content ?? '',
        ready: query.isSuccess,
        error: query.error,
      };
}

export function DocumentHistory({
  field,
  live,
  children,
  hasUnsavedChanges = false,
  onRestored,
}: {
  field: string;
  live: string;
  children?: ReactNode;
  hasUnsavedChanges?: boolean;
  onRestored?: () => void;
}) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [picked, setPicked] = useState<string | null>(null);
  const [compareWith, setCompareWith] = useState(LIVE);
  const [compareOpen, setCompareOpen] = useState(false);
  const [pending, setPending] = useState<{
    revision: DocumentRevisionSummary;
    expectedId: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [restoredId, setRestoredId] = useState<string | null>(null);
  const historyQuery = useQuery({
    queryKey: ['document-revisions', field],
    queryFn: () => runtimeApi.documentRevisions(field),
  });
  const history = historyQuery.data;
  const revisions = history?.revisions ?? [];
  const selected = revisions.find((revision) => revision.id === picked);
  const driftComparison = Boolean(
    history?.drifted && !selected && revisions.length,
  );
  const fromId = selected?.id ?? (driftComparison ? revisions[0].id : LIVE);
  const toId = selected ? compareWith : LIVE;
  const older = useSideContent(field, fromId, live);
  const newer = useSideContent(field, toId, live);
  const showDiff = Boolean(selected || driftComparison);
  const matchesCurrent = selected?.matchesCurrent ?? false;
  const comparisonTitle = revisions.find((revision) => revision.id === toId);

  const restore = useMutation({
    mutationFn: (input: NonNullable<typeof pending>) =>
      runtimeApi.restoreDocumentRevision(
        field,
        input.revision.id,
        input.expectedId,
      ),
    onMutate: () => {
      setError(null);
      setRestoredId(null);
    },
    onSuccess: (result) => {
      queryClient.setQueryData(
        ['agent-details', agent.agentId],
        (old: AgentDetails | undefined) =>
          old ? { ...old, [field]: result.content } : old,
      );
      setPending(null);
      setPicked(result.revision.id);
      setCompareWith(LIVE);
      setCompareOpen(false);
      setRestoredId(result.revision.id);
      onRestored?.();
      queryClient.invalidateQueries({
        queryKey: ['document-revisions', field],
      });
      queryClient.invalidateQueries({
        queryKey: ['agent-details', agent.agentId],
      });
    },
    onError: (e: unknown) => {
      setPending(null);
      setError(
        e instanceof ApiError && e.status === 409
          ? 'This document changed. Refresh the history before restoring.'
          : e instanceof Error
            ? e.message
            : 'Restore failed',
      );
    },
  });

  function pick(id: string | null) {
    setPicked(id);
    setCompareWith(LIVE);
    setCompareOpen(false);
    setError(null);
    setRestoredId(null);
  }

  return (
    <div className="mt-4 grid min-w-0 gap-0 overflow-hidden rounded-xl border border-border lg:grid-cols-[minmax(0,1fr)_280px]">
      <section aria-label="Document workspace" className="min-w-0 p-4 sm:p-5">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="mb-1 text-[11px] font-medium uppercase tracking-widest text-foreground/65">
              {showDiff ? 'Version comparison' : 'Your agent’s instructions'}
            </p>
            <h3 className="break-words text-base font-semibold">
              {selected
                ? revisionTitle(selected)
                : driftComparison
                  ? 'Unrecorded changes'
                  : 'Current document'}
            </h3>
            <p className="mt-1 text-xs text-foreground/70">
              {selected
                ? new Date(selected.createdAt).toLocaleString()
                : showDiff
                  ? 'Latest saved version compared with the current document.'
                  : 'Used on the next turn'}
            </p>
          </div>
          {selected && (
            <Button variant="ghost" size="sm" onClick={() => pick(null)}>
              <ArrowLeft /> Current document
            </Button>
          )}
        </div>

        {restoredId && (
          <p
            role="status"
            className="mb-4 flex items-center gap-2 rounded-lg bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-400"
          >
            <Check className="size-4" /> Version restored. Your agent will use
            it on the next turn.
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="mb-4 flex flex-wrap items-center gap-2 text-sm text-destructive"
          >
            {error}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                historyQuery.refetch();
                queryClient.invalidateQueries({
                  queryKey: ['agent-details', agent.agentId],
                });
                setError(null);
              }}
            >
              Refresh history
            </Button>
          </div>
        )}

        {history?.drifted && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/5 p-3 text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="text-sm font-medium">
                Current document has unrecorded changes
              </p>
              <p className="mt-1 text-xs leading-5">
                These changes are not in a saved version.
              </p>
              {selected && (
                <Button
                  variant="link"
                  className="h-auto p-0 text-amber-200"
                  onClick={() => pick(null)}
                >
                  View unrecorded changes
                </Button>
              )}
            </div>
          </div>
        )}

        <div hidden={showDiff && !driftComparison}>{children}</div>

        {showDiff && (
          <div className={cn(driftComparison && 'mt-5')}>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h4 className="text-sm font-medium">
                Changes to the{' '}
                {toId === LIVE ? 'current document' : 'compared version'}
              </h4>
              {selected && (
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={compareOpen}
                  onClick={() => {
                    setCompareOpen(!compareOpen);
                    setCompareWith(LIVE);
                  }}
                >
                  <GitCompareArrows /> Compare versions
                </Button>
              )}
            </div>
            {compareOpen && (
              <div className="mb-3 flex items-center gap-2 text-xs text-foreground/75">
                Compare with
                <Select
                  value={compareWith}
                  onValueChange={(value) => value && setCompareWith(value)}
                >
                  <SelectTrigger
                    aria-label="Compare with"
                    className="min-w-0 max-w-80"
                  >
                    <SelectValue>
                      {comparisonTitle
                        ? revisionTitle(comparisonTitle)
                        : 'Current document'}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={LIVE}>Current document</SelectItem>
                    {revisions.map((revision) => (
                      <SelectItem key={revision.id} value={revision.id}>
                        {revisionTitle(revision)} ·{' '}
                        {new Date(revision.createdAt).toLocaleString()}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {older.error || newer.error ? (
              <p role="alert" className="text-sm text-destructive">
                This version could not be loaded. Select another version or
                refresh the page.
              </p>
            ) : older.ready && newer.ready ? (
              <RevisionDiff
                older={older.content}
                newer={newer.content}
                olderLabel={
                  selected ? revisionTitle(selected) : 'Latest saved version'
                }
                newerLabel={
                  comparisonTitle
                    ? revisionTitle(comparisonTitle)
                    : 'Current document'
                }
              />
            ) : (
              <Skeleton className="h-40" />
            )}
            {selected && (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                <p className="text-xs text-foreground/70">
                  {matchesCurrent
                    ? 'This version matches the current document.'
                    : 'Restoring saves a new version. You can undo it later.'}
                </p>
                <Button
                  disabled={!older.ready || matchesCurrent || restore.isPending}
                  onClick={() =>
                    setPending({
                      revision: selected,
                      expectedId: revisions[0].id,
                    })
                  }
                >
                  <RotateCcw /> Restore this version
                </Button>
              </div>
            )}
          </div>
        )}
      </section>

      <aside
        aria-label="Version history"
        className="min-w-0 border-t border-border bg-background/25 lg:border-t-0 lg:border-l"
      >
        <div className="flex items-center justify-between px-4 pt-5 pb-3">
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <History className="size-4 text-foreground/70" /> Version history
          </h3>
          <span className="rounded-full bg-accent px-2 py-0.5 text-xs text-foreground/75">
            {revisions.length}
          </span>
        </div>
        <div className="px-3 pb-3">
          <button
            type="button"
            aria-pressed={!selected}
            onClick={() => pick(null)}
            className={cn(
              'w-full rounded-lg border px-3 py-3 text-left text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring',
              !selected
                ? 'border-primary/50 bg-primary/10'
                : 'border-transparent hover:bg-accent',
            )}
          >
            <span className="flex items-center justify-between">
              Current document
              <span className="size-2 rounded-full bg-emerald-400" />
            </span>
            <span className="mt-1 block text-xs font-normal text-foreground/70">
              {hasUnsavedChanges
                ? 'You have an unsaved draft'
                : 'The version your agent uses'}
            </span>
          </button>
        </div>
        <div className="max-h-80 space-y-1 overflow-y-auto border-t border-border px-3 py-3 lg:max-h-[420px]">
          {historyQuery.isLoading && <Skeleton className="h-24" />}
          {historyQuery.error && (
            <p role="alert" className="p-2 text-sm text-destructive">
              History could not be loaded.
            </p>
          )}
          {revisions.map((revision) => (
            <RevisionListItem
              key={revision.id}
              revision={revision}
              selected={selected?.id === revision.id}
              current={revision.matchesCurrent}
              onSelect={() => pick(revision.id)}
            />
          ))}
          {!historyQuery.isLoading &&
            !historyQuery.error &&
            !revisions.length && (
              <p className="p-2 text-xs leading-5 text-foreground/70">
                No saved versions yet. Your next edit starts the history.
              </p>
            )}
        </div>
        <p className="border-t border-border px-5 py-3 text-[11px] text-foreground/65">
          Keeps the latest {history?.bound ?? 500} versions.
        </p>
      </aside>

      <AlertDialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open && !restore.isPending) setPending(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              Restore “{pending ? revisionTitle(pending.revision) : ''}” from{' '}
              {pending
                ? new Date(pending.revision.createdAt).toLocaleString()
                : ''}
              . This saves a new version and takes effect on the next turn.
              {hasUnsavedChanges && ' Your unsaved draft will be replaced.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restore.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={restore.isPending}
              onClick={() => pending && restore.mutate(pending)}
            >
              {restore.isPending ? 'Restoring…' : 'Restore version'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
