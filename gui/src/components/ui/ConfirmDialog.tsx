interface Props {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isPending?: boolean;
  entityType: string;
  entityName: string;
  warning?: string;
}

/** Destructive-action confirmation. Mirrors web's shared DeleteConfirm. */
export function ConfirmDialog({
  isOpen,
  onClose,
  onConfirm,
  isPending = false,
  entityType,
  entityName,
  warning,
}: Props) {
  if (!isOpen) return null;
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="modal-title">Delete {entityType}</h3>
        <div className="modal-body">
          {warning ? <p className="confirm-warning">{warning}</p> : null}
          <p>
            Are you sure you want to delete <strong>{entityName}</strong>? This action cannot be
            undone.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-danger"
            onClick={onConfirm}
            disabled={isPending}
          >
            {isPending ? 'Deleting…' : 'Delete'}
          </button>
        </div>
      </div>
    </div>
  );
}
