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
    setError(null);
    try {
      await onSubmit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto py-2">
          {error && <FieldError>{error}</FieldError>}
          {children}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={submitDisabled || isSubmitting}>
            {isSubmitting ? `${submitLabel.replace(/e$/, '')}ing...` : submitLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
