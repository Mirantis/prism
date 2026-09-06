import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, History, RotateCcw } from 'lucide-react';
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
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ApiError } from '@/api/errors';
import { runtimeApi } from '@/api/runtime-client';
import { useAgent } from '@/lib/agent-context';
import { RevisionDiff } from '@/components/profile/revision-diff';
import type { DocumentRevisionSummary } from '@/types';

/** The comparable side that is the document as it stands now. */
const LIVE = 'live';

const STALE_MESSAGE = 'Someone else changed this document; reload the history.';

function revisionLabel(revision: DocumentRevisionSummary): string {
  return `${new Date(revision.createdAt).toLocaleString()} — ${revision.actor}, ${revision.method}`;
}

/** The two sides a reader most likely wants: the newest change and what preceded it. */
function defaultSides(revisions: DocumentRevisionSummary[]): { older: string; newer: string } {
  if (revisions.length >= 2) return { older: revisions[1].id, newer: revisions[0].id };
  if (revisions.length === 1) return { older: revisions[0].id, newer: LIVE };
  return { older: LIVE, newer: LIVE };
}

/** The text of one comparable side. The live document is already in the page. */
function useSideContent(field: string, side: string, live: string): { content: string; read: boolean } {
  const query = useQuery({
    queryKey: ['document-revision', field, side],
    queryFn: () => runtimeApi.documentRevision(field, side),
    enabled: side !== LIVE,
  });
  if (side === LIVE) return { content: live, read: true };
  if (query.isSuccess) return { content: query.data.content, read: true };
  return { content: '', read: false };
}

/**
 * The history of one identity document under its tab on the Profile page: what
 * was written and by whom, the difference between two versions, and the restore
 * of an earlier one.
 */
export function DocumentHistory({ field, live }: { field: string; live: string }) {
  const agent = useAgent();
  const queryClient = useQueryClient();
  const [pickedOlder, setPickedOlder] = useState<string | null>(null);
  const [pickedNewer, setPickedNewer] = useState<string | null>(null);
  const [pending, setPending] = useState<DocumentRevisionSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  const {
    data: history,
    isLoading,
    error: historyError,
  } = useQuery({
    queryKey: ['document-revisions', field],
    queryFn: () => runtimeApi.documentRevisions(field),
  });

  const revisions = history?.revisions ?? [];
  const defaults = defaultSides(revisions);
  const older = pickedOlder ?? defaults.older;
  const newer = pickedNewer ?? defaults.newer;
  const olderContent = useSideContent(field, older, live);
  const newerContent = useSideContent(field, newer, live);

  const restore = useMutation({
    mutationFn: (revisionId: string) =>
      runtimeApi.restoreDocumentRevision(field, revisionId, revisions[0]?.id ?? ''),
    onMutate: () => setError(null),
    onSuccess: () => {
      setPending(null);
      setPickedOlder(null);
      setPickedNewer(null);
      queryClient.invalidateQueries({ queryKey: ['document-revisions', field] });
      queryClient.invalidateQueries({ queryKey: ['document-revision', field] });
      queryClient.invalidateQueries({ queryKey: ['agent-details', agent.agentId] });
    },
    onError: (e: unknown) => {
      setPending(null);
      if (e instanceof ApiError && e.status === 409) {
        setError(STALE_MESSAGE);
        return;
      }
      setError(e instanceof Error ? e.message : 'Restore failed');
    },
  });

  if (isLoading) {
    return <Skeleton className="mt-4 h-24" />;
  }

  if (historyError) {
    return (
      <p className="mt-4 text-xs text-destructive">
        The history could not be read: {historyError.message}
      </p>
    );
  }

  const sides = [
    { value: LIVE, label: 'Current document' },
    ...revisions.map((revision) => ({ value: revision.id, label: revisionLabel(revision) })),
  ];
  const labelOf = (value: string) => sides.find((side) => side.value === value)?.label ?? value;

  return (
    <div className="mt-4 flex flex-col gap-3 border-t border-border pt-4">
      <div className="flex items-center gap-2 text-sm font-medium">
        <History className="size-4 text-muted-foreground" />
        History
      </div>

      {history?.drifted && (
        <Alert variant="destructive">
          <AlertTriangle />
          <AlertTitle>This document was changed outside the app</AlertTitle>
          <AlertDescription>
            It no longer matches its newest revision, so the difference below shows what the change
            did. Restore a revision to put a known version back.
          </AlertDescription>
        </Alert>
      )}

      {error && <p className="text-xs text-destructive">{error}</p>}

      {revisions.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No revisions yet. The next write to this document records one.
        </p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs text-muted-foreground">Compare</span>
            <Select value={older} onValueChange={(value) => value && setPickedOlder(value)}>
              <SelectTrigger aria-label="Older version" className="max-w-72">
                <SelectValue>{labelOf(older)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sides.map((side) => (
                  <SelectItem key={side.value} value={side.value}>
                    {side.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-xs text-muted-foreground">with</span>
            <Select value={newer} onValueChange={(value) => value && setPickedNewer(value)}>
              <SelectTrigger aria-label="Newer version" className="max-w-72">
                <SelectValue>{labelOf(newer)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sides.map((side) => (
                  <SelectItem key={side.value} value={side.value}>
                    {side.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {olderContent.read && newerContent.read ? (
            <RevisionDiff older={olderContent.content} newer={newerContent.content} />
          ) : (
            <Skeleton className="mt-3 h-24" />
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Who</TableHead>
                <TableHead>How</TableHead>
                <TableHead>Why</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {revisions.map((revision) => (
                <TableRow key={revision.id}>
                  <TableCell className="whitespace-nowrap">
                    {new Date(revision.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{revision.actor}</TableCell>
                  <TableCell>
                    <Badge variant="secondary">{revision.method}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{revision.reason}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setError(null);
                        setPending(revision);
                      }}
                      disabled={restore.isPending}
                    >
                      <RotateCcw className="size-3.5" />
                      Restore
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <span className="text-xs text-muted-foreground">
            This document keeps its newest {history?.bound} revisions.
          </span>
        </>
      )}

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this version?</AlertDialogTitle>
            <AlertDialogDescription>
              The document goes back to the version from{' '}
              {pending ? new Date(pending.createdAt).toLocaleString() : ''}, and the history gains a
              revision for the restore. The agent reads the restored document on its next turn.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => pending && restore.mutate(pending.id)}
              disabled={restore.isPending}
            >
              Restore
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
