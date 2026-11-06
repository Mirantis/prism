import { attachmentUrl } from '@/api/runtime-client';
import type { Attachment } from '@/types';

export const ATTACHMENT_SCHEME = 'attachment:';

interface InlineImageProps {
  src: string | undefined;
  alt: string | undefined;
  /** The message's files. */
  attachments: Attachment[] | null | undefined;
}

/**
 * An image a message places in its text. Only the message's own inline images
 * load. Any other source shows its alt text, as a link when it is a web
 * address, so a message never makes the browser fetch an image from another host.
 */
export default function InlineImage({ src, alt, attachments }: InlineImageProps) {
  const label = alt?.trim() || 'image';
  const id = src?.startsWith(ATTACHMENT_SCHEME) ? src.slice(ATTACHMENT_SCHEME.length) : null;
  const attachment = id ? attachments?.find((a) => a.id === id && a.inline) : undefined;

  if (!attachment) {
    if (src && /^https?:\/\//i.test(src)) {
      return (
        <a
          href={src}
          className="text-primary underline decoration-primary/40 underline-offset-2 hover:decoration-primary"
          target="_blank"
          rel="noopener noreferrer"
        >
          {label}
        </a>
      );
    }
    return <span>{label}</span>;
  }

  if (attachment.expired) {
    return (
      <span
        className="my-2 inline-block rounded-lg border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
        title={`${attachment.filename} — expired (files are kept for 7 days)`}
        data-testid="inline-image-expired"
      >
        {label} · expired
      </span>
    );
  }

  const url = attachmentUrl(attachment.id);
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" className="my-2 block w-fit" title={attachment.filename}>
      <img
        src={url}
        alt={label}
        loading="lazy"
        className="max-h-[480px] max-w-full rounded-lg ring-1 ring-border"
        data-testid="inline-image"
      />
    </a>
  );
}
