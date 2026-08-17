/**
 * Channel-agnostic text chunking.
 *
 * Extracted from slack-formatter.ts so every channel formatter (Slack blocks,
 * Teams activities) splits long output the same way: paragraph boundaries
 * first, then sentences / newlines / spaces, hard split as the last resort.
 */

/**
 * Split content into chunks respecting paragraph boundaries
 */
export function splitContent(text: string, maxLength: number): string[] {
  const sections: string[] = [];
  let currentSection = '';

  // Split by double newlines (paragraphs) or code blocks
  const paragraphs = text.split(/\n\n+/);

  for (const para of paragraphs) {
    // Check if adding this paragraph would exceed the limit
    const wouldBe = currentSection + (currentSection ? '\n\n' : '') + para;

    if (wouldBe.length <= maxLength) {
      currentSection = wouldBe;
    } else {
      // Save current section and start new one
      if (currentSection.trim()) {
        sections.push(currentSection.trim());
      }

      // If single paragraph is too long, split it further
      if (para.length > maxLength) {
        const chunks = splitLongText(para, maxLength);
        sections.push(...chunks.slice(0, -1));
        currentSection = chunks[chunks.length - 1] || '';
      } else {
        currentSection = para;
      }
    }
  }

  // Add remaining content
  if (currentSection.trim()) {
    sections.push(currentSection.trim());
  }

  return sections;
}

/**
 * Split very long text by sentences or words.
 *
 * Every chunk is at most `maxLength` characters — the slice below is
 * `splitPoint + 1`, so boundaries are searched from `maxLength - 1` and the
 * hard split lands exactly on `maxLength` (a boundary found at `maxLength`
 * itself would overshoot the contract by one character).
 */
export function splitLongText(text: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at sentence boundary
    let splitPoint = remaining.lastIndexOf('. ', maxLength - 1);
    if (splitPoint === -1 || splitPoint < maxLength / 2) {
      // Try newline
      splitPoint = remaining.lastIndexOf('\n', maxLength - 1);
    }
    if (splitPoint === -1 || splitPoint < maxLength / 2) {
      // Try space
      splitPoint = remaining.lastIndexOf(' ', maxLength - 1);
    }
    if (splitPoint === -1) {
      // Hard split
      splitPoint = maxLength - 1;
    }

    chunks.push(remaining.substring(0, splitPoint + 1).trim());
    remaining = remaining.substring(splitPoint + 1).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}
