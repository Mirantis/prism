import { type ReactNode, useEffect, useState } from 'react';
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';

interface CreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  onSubmit: () => void | Promise<void>;
  isSubmitting: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  children: ReactNode;
}

export function CreateModal({
  isOpen,
  onClose,
  title,
  onSubmit,
  isSubmitting,
  submitLabel = 'Create',
  submitDisabled = false,
  children,
}: CreateModalProps) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setError(null); }, [isOpen]);

  const handleSubmit = async () => {
    if (submitDisabled || isSubmitting) return;
    setError(null);
    try {
      await onSubmit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col">
        <form
          className="flex min-h-0 flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <DialogHeader className="shrink-0 pr-6">
            <DialogTitle className="break-words leading-snug">{title}</DialogTitle>
          </DialogHeader>
          <div className="flex min-h-0 max-h-[60vh] flex-col gap-4 overflow-y-auto px-1 py-2 -mx-1">
            {error && <FieldError>{error}</FieldError>}
            {children}
          </div>
          <DialogFooter className="shrink-0">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={submitDisabled || isSubmitting}>
              {isSubmitting ? `${submitLabel.replace(/e$/, '')}ing...` : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
