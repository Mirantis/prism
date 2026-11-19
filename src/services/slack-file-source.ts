import { MAX_FILE_SIZE_BYTES, MAX_FILE_SIZE_MB } from '../constants';
import type { SlackFileMeta } from './slack-adapter.service';

/**
 * Where to download a Slack file from, or why it cannot be downloaded, decided
 * from the file's metadata alone, so a file that can never be stored takes no
 * download.
 */
export function slackFileSource(file: SlackFileMeta): { url: string } | { reason: string } {
  if (typeof file.size === 'number' && file.size > MAX_FILE_SIZE_BYTES) {
    return { reason: `it exceeds the ${MAX_FILE_SIZE_MB} MB limit` };
  }
  const url = file.url_private_download || file.url_private;
  if (!url) return { reason: 'Slack returned no download URL for it' };
  return { url };
}
