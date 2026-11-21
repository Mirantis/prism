/** The tallest picture, in rows, about the height the web chat gives one. */
export const MAX_IMAGE_ROWS = 24;

/** A cell when the terminal did not report its size: twice as tall as wide. */
export const DEFAULT_CELL = { width: 10, height: 20 };

/**
 * The cells a picture takes: its own size in cells of `cell` pixels, made
 * smaller to fit within `maxCols` × `maxRows` with its proportions kept. A
 * picture is never enlarged.
 */
export function imageCells(
  width: number,
  height: number,
  cell: { width: number; height: number },
  maxCols: number,
  maxRows: number,
): { cols: number; rows: number } {
  const naturalCols = width / cell.width;
  const naturalRows = height / cell.height;
  const scale = Math.min(1, maxCols / naturalCols, maxRows / naturalRows);
  return {
    cols: Math.max(1, Math.min(maxCols, Math.round(naturalCols * scale))),
    rows: Math.max(1, Math.min(maxRows, Math.round(naturalRows * scale))),
  };
}
