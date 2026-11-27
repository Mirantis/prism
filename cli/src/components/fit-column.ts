/**
 * Truncate to fit a column, leaving room for an ellipsis. Cells are rendered
 * inside a fixed-width <Box>, but pre-truncating keeps ink from wrapping a
 * long value onto a second line and breaking row alignment.
 */
export function fitColumn(s: string, width: number): string {
  const max = width - 2;
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}
