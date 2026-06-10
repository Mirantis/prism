import { File as FileIcon, FileText, Image as ImageIcon, Loader2, X } from 'lucide-react';
import { attachmentUrl } from '@/api/runtime-client';
import type { Attachment, AttachmentCategory } from '@/types';

/** A file in the composer, before/while uploading, or after it's stored. */
export interface PendingAttachment {
  localId: string;
  id?: string;
  filename: string;
  mediaType: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status: 'uploading' | 'ready' | 'error';
  error?: string;
}

/**
 * Human-readable byte size, e.g. "1.2 MB".
 *
 * Kept in sync with the runtime's `attachment.service.ts#humanFileSize` and
 * the CLI's `attachments.ts#formatFileSize` — separate workspaces, so the
 * formatter is mirrored rather than imported.
 */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function CategoryIcon({ category }: { category: AttachmentCategory }) {
  if (category === 'image') return <ImageIcon className="size-4 shrink-0" />;
  if (category === 'text' || category === 'pdf') return <FileText className="size-4 shrink-0" />;
  return <FileIcon className="size-4 shrink-0" />;
}

interface ChipBodyProps {
  filename: string;
  sizeBytes: number;
  category: AttachmentCategory;
  status?: PendingAttachment['status'];
  error?: string;
}

function ChipBody({ filename, sizeBytes, category, status, error }: ChipBodyProps) {
  return (
    <>
      {status === 'uploading' ? (
        <Loader2 className="size-4 shrink-0 animate-spin" />
      ) : (
        <CategoryIcon category={category} />
      )}
      <span className="flex min-w-0 flex-col text-left">
        <span className="truncate text-xs font-medium">{filename}</span>
        <span className="truncate text-[10px] text-muted-foreground">
          {status === 'error' ? (error ?? 'Upload failed') : humanSize(sizeBytes)}
        </span>
      </span>
    </>
  );
}

const CHIP_CLASS =
  'flex max-w-[220px] items-center gap-2 rounded-lg border bg-muted/40 px-2.5 py-1.5';

/** Read-only chip rendered on a sent/historical message — click to download. */
export function MessageAttachmentChip({ attachment }: { attachment: Attachment }) {
  return (
    <a
      href={attachmentUrl(attachment.id)}
      download={attachment.filename}
      target="_blank"
      rel="noopener noreferrer"
      data-testid="message-attachment"
      className={`${CHIP_CLASS} transition-colors hover:bg-muted`}
      title={`Download ${attachment.filename}`}
    >
      <ChipBody
        filename={attachment.filename}
        sizeBytes={attachment.sizeBytes}
        category={attachment.category}
      />
    </a>
  );
}

/** Composer chip with a remove button, reflecting upload status. */
export function PendingAttachmentChip({
  attachment,
  onRemove,
}: {
  attachment: PendingAttachment;
  onRemove: (localId: string) => void;
}) {
  return (
    <div
      data-testid="composer-attachment"
      className={`${CHIP_CLASS} ${attachment.status === 'error' ? 'border-destructive/50' : ''}`}
    >
      <ChipBody
        filename={attachment.filename}
        sizeBytes={attachment.sizeBytes}
        category={attachment.category}
        status={attachment.status}
        error={attachment.error}
      />
      <button
        type="button"
        onClick={() => onRemove(attachment.localId)}
        className="ml-auto rounded-full p-0.5 text-muted-foreground hover:bg-muted-foreground/20 hover:text-foreground"
        aria-label={`Remove ${attachment.filename}`}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
