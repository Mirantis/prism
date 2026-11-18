/** An ACP prompt as the text and the files of one Prism message. */

import { fileURLToPath } from 'node:url';
import type { ContentBlock } from '@agentclientprotocol/sdk';

export interface PromptImage {
  data: Uint8Array;
  filename: string;
}

export interface PromptContent {
  text: string;
  images: PromptImage[];
}

/**
 * The blocks in order, as one text. A linked file becomes its path, which the
 * agent reads with its own tools, and an image becomes a file to upload.
 */
export function promptContent(blocks: ContentBlock[]): PromptContent {
  const images: PromptImage[] = [];
  let text = '';
  let afterLink = false;
  for (const block of blocks) {
    if (block.type === 'image') {
      const subtype = block.mimeType.slice(block.mimeType.indexOf('/') + 1);
      images.push({ data: Buffer.from(block.data, 'base64'), filename: `image.${subtype}` });
    }
    if (block.type !== 'text' && block.type !== 'resource_link') continue;
    const isLink = block.type === 'resource_link';
    const part = isLink ? linkText(block.uri) : block.text;
    // A link is a word of its own: a client can send two in a row, or one right after a text.
    const touching = text !== '' && part !== '' && !/\s$/.test(text) && !/^\s/.test(part);
    text += (touching && (isLink || afterLink) ? ' ' : '') + part;
    afterLink = isLink;
  }
  return { text, images };
}

/** A file link as its path and fragment. Any other link as it is. */
function linkText(uri: string): string {
  if (!uri.startsWith('file:')) return uri;
  const url = new URL(uri);
  return fileURLToPath(url) + url.hash;
}
