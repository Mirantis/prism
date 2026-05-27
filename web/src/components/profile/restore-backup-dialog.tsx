import { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { runtimeApi } from '@/api/runtime-client';
import { AlertTriangle, Loader2 } from 'lucide-react';

type Phase = 'pick' | 'uploading' | 'restarting' | 'error';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RestoreBackupDialog({ open, onOpenChange }: Props) {
  const [phase, setPhase] = useState<Phase>('pick');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    if (open) {
      setPhase('pick');
      setFile(null);
      setError(null);
    }
    return () => {
      if (pollRef.current != null) {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [open]);

  const startHealthPoll = () => {
    pollRef.current = window.setInterval(async () => {
      try {
        const res = await fetch('/health', { cache: 'no-store' });
        if (res.ok) {
          if (pollRef.current != null) window.clearInterval(pollRef.current);
          window.location.reload();
        }
      } catch {
        // runtime still down — keep polling
      }
    }, 500);
  };

  const onRestore = async () => {
    if (!file) return;
    setPhase('uploading');
    setError(null);
    try {
      await runtimeApi.importAgent(file);
      setPhase('restarting');
      startHealthPoll();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restore failed');
      setPhase('error');
    }
  };

  const closable = phase !== 'restarting' && phase !== 'uploading';

  return (
    <Dialog open={open} onOpenChange={(o) => closable && onOpenChange(o)}>
      <DialogContent showCloseButton={closable}>
        <DialogHeader>
          <DialogTitle>Restore</DialogTitle>
          <DialogDescription>
            Replace this agent's entire database with the uploaded snapshot and restart the
            runtime. Anything written since the backup will be lost.
          </DialogDescription>
        </DialogHeader>

        {phase === 'restarting' ? (
          <div className="flex items-center gap-3 py-4 text-sm">
            <Loader2 className="size-4 animate-spin" />
            Restarting runtime — reconnecting…
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <Alert variant="destructive">
              <AlertTriangle />
              <AlertTitle>This is destructive</AlertTitle>
              <AlertDescription>
                Chat history, memory, scheduled tasks, settings, and Slack mappings will all
                be replaced.
              </AlertDescription>
            </Alert>

            <label className="flex flex-col gap-1.5 text-sm">
              <span className="text-xs text-muted-foreground">Backup file (.prism)</span>
              <input
                type="file"
                accept=".prism"
                onChange={(e) => {
                  setError(null);
                  setFile(e.target.files?.[0] ?? null);
                }}
                disabled={phase === 'uploading'}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-background file:px-3 file:py-1.5 file:text-sm file:font-medium hover:file:bg-accent disabled:opacity-50"
              />
            </label>

            {error && (
              <Alert variant="destructive">
                <AlertTriangle />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}

        {phase !== 'restarting' && (
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={phase === 'uploading'}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={onRestore}
              disabled={!file || phase === 'uploading'}
            >
              {phase === 'uploading' ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                'Restore'
              )}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
