import type { Attachment } from '@/types';
import InlineImage from '../inline-image';

/** One of the message's own images, loaded as an inline image is. */
export function ImageElement({ attachment, alt, attachments }: { attachment: string; alt: string; attachments: Attachment[] | null | undefined }) {
  return <InlineImage src={attachment} alt={alt} attachments={attachments} />;
}
