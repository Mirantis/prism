import { useEffect, useState, type ReactNode } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  onSubmit: () => void | Promise<void>;
  isSubmitting?: boolean;
  submitLabel?: string;
  submitDisabled?: boolean;
  children: ReactNode;
}

/** Generic create/edit dialog. Mirrors web's shared CreateModal. */
export function Modal({
  isOpen,
  onClose,
  title,
  onSubmit,
  isSubmitting = false,
  submitLabel = 'Create',
  submitDisabled = false,
  children,
}: Props) {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async () => {
    setError(null);
    try {
      await onSubmit();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">{title}</h3>
        <div className="modal-body">
          {error ? <div className="field-error">{error}</div> : null}
          {children}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSubmit}
            disabled={submitDisabled || isSubmitting}
          >
            {isSubmitting ? 'Saving…' : submitLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
