import React, { useEffect, useMemo, useState } from 'react';
import { Text, useStdout } from 'ink';
import type { AttachmentMeta } from '../attachments.js';
import type { Bitmap } from '../images/bitmap.js';
import { loadAttachmentImage } from '../images/attachment-images.js';
import { imageCells } from '../images/image-size.js';
import { kittyPlaceholderLines } from '../images/kitty.js';
import { kittyImageId, sendKittyImage } from '../images/kitty-images.js';

const ATTACHMENT_SCHEME = 'attachment:';

interface InlineImageProps {
  href: string;
  alt: string;
  /** The message's files. */
  attachments: AttachmentMeta[] | null | undefined;
  /** The pixel size of one terminal cell. */
  cell: { width: number; height: number };
  maxCols: number;
  maxRows: number;
}

/**
 * An image a message places in its text, drawn at its place with the kitty
 * graphics protocol. Only the message's own inline images draw, as in the web
 * chat. Until the picture is ready the image reads as its description.
 */
export const InlineImage: React.FC<InlineImageProps> = ({ href, alt, attachments, cell, maxCols, maxRows }) => {
  const id = href.startsWith(ATTACHMENT_SCHEME) ? href.slice(ATTACHMENT_SCHEME.length) : null;
  const attachment = id ? attachments?.find((a) => a.id === id && a.inline) : undefined;
  const drawable = attachment !== undefined && !attachment.expired;
  const [bitmap, setBitmap] = useState<Bitmap | null>(null);
  const { stdout } = useStdout();

  useEffect(() => {
    if (!drawable) return;
    let mounted = true;
    loadAttachmentImage(attachment).then(
      (loaded) => mounted && setBitmap(loaded),
      () => undefined,
    );
    return () => {
      mounted = false;
    };
  }, [drawable, attachment]);

  const cells = bitmap ? imageCells(bitmap.width, bitmap.height, cell, maxCols, maxRows) : null;
  const kittyId = attachment && cells ? kittyImageId(attachment.id, cells.cols, cells.rows) : null;

  useEffect(() => {
    if (!bitmap || !cells || kittyId === null) return;
    sendKittyImage(kittyId, bitmap, cells.cols, cells.rows, cell, (s) => stdout.write(s));
  }, [bitmap, cells?.cols, cells?.rows, kittyId, cell, stdout]);

  const lines = useMemo(
    () => (cells && kittyId !== null ? kittyPlaceholderLines(kittyId, cells.cols, cells.rows) : null),
    [cells?.cols, cells?.rows, kittyId],
  );

  if (attachment?.expired) return <Text dimColor>{`[image: ${alt} · expired]`}</Text>;
  if (!lines) return <Text dimColor={drawable}>{`[image: ${alt}]`}</Text>;
  return <Text>{lines.join('\n')}</Text>;
};
