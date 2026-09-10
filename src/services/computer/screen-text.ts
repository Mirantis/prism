/**
 * Words on the screen, with where they are: Tesseract over a grab of the display, so a
 * target with a label can be clicked at its exact centre instead of at a coordinate the
 * model estimated. Measured against the truth, the model's estimates miss a menu row
 * about one time in four and a window button almost always; OCR does not.
 *
 * The grab is upscaled before OCR. The desktop's font is nine pixels tall at native
 * size, which Tesseract breaks into fragments; at twice the size it reads the words whole.
 * Boxes come back divided by that factor, in screen pixels.
 */

import { spawn } from 'child_process';

/** One word Tesseract read, in screen pixels. */
export interface ScreenWord {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
  /** Which line of text it belongs to, so a phrase is matched within one line. */
  line: string;
}

/** A run of words matching a query, in screen pixels. */
export interface TextMatch {
  /** The matched words as read. */
  text: string;
  /** The whole line they sit in, for telling matches apart. */
  line: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Words read with less confidence than this are noise, not labels. */
const MIN_CONFIDENCE = 30;
const OCR_TIMEOUT_MS = 20_000;

/** Run Tesseract on a PNG of the display scaled up `scale` times; boxes come back in screen pixels. */
export function readScreenWords(png: Buffer, scale: number): Promise<ScreenWord[]> {
  return new Promise((resolve, reject) => {
    // Page segmentation mode 11 is sparse text: find words wherever they are, in no
    // assumed layout, which is what a desktop with a menu, a panel and windows is.
    const proc = spawn('tesseract', ['stdin', 'stdout', '--psm', '11', 'tsv'], {
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('OCR timed out'));
    }, OCR_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`tesseract exited with ${code}`));
      resolve(parseTsv(Buffer.concat(chunks).toString('utf8'), scale));
    });
    proc.stdin.end(png);
  });
}

/**
 * Tesseract's TSV: level, page, block, paragraph, line, word, left, top, width, height,
 * confidence, text. Level 5 rows are words.
 */
export function parseTsv(tsv: string, scale: number): ScreenWord[] {
  const words: ScreenWord[] = [];
  for (const row of tsv.split('\n').slice(1)) {
    const cols = row.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols[11].trim();
    const confidence = Number(cols[10]);
    if (!text || !(confidence >= MIN_CONFIDENCE)) continue;
    words.push({
      text,
      left: Number(cols[6]) / scale,
      top: Number(cols[7]) / scale,
      width: Number(cols[8]) / scale,
      height: Number(cols[9]) / scale,
      confidence,
      line: `${cols[2]}-${cols[3]}-${cols[4]}`,
    });
  }
  return words;
}

/**
 * Enlarge a JPEG `scale` times into a PNG for OCR, through ffmpeg on pipes. For a picture
 * that did not come off the display, such as the user's shared screen.
 */
export function upscaleForOcr(jpeg: Buffer, scale: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      'ffmpeg',
      ['-loglevel', 'error', '-i', 'pipe:0', '-vf', `scale=iw*${scale}:ih*${scale}`, '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error('upscale timed out'));
    }, OCR_TIMEOUT_MS);
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg exited with ${code}`));
      resolve(Buffer.concat(chunks));
    });
    proc.stdin.end(jpeg);
  });
}

/** The words as lines of text, top to bottom, each line's words left to right. */
export function readLines(words: ScreenWord[]): string[] {
  const lines = new Map<string, ScreenWord[]>();
  for (const word of words) lines.set(word.line, [...(lines.get(word.line) ?? []), word]);
  return [...lines.values()]
    .map((line) => line.sort((a, b) => a.left - b.left))
    .sort((a, b) => a[0].top - b[0].top || a[0].left - b[0].left)
    .map((line) => line.map((w) => w.text).join(' '));
}

/** Letters and digits only, lower case: "Run Program..." and "run program" are one thing. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Where `query` appears on the screen, top to bottom.
 *
 * A phrase matches consecutive words on one line, each word compared with punctuation
 * and case removed. A single word that matches nothing whole also matches a word that
 * starts with it, since a label can be cut by a window edge or read short.
 */
export function findText(words: ScreenWord[], query: string): TextMatch[] {
  const wanted = query.trim().split(/\s+/).map(normalize).filter(Boolean);
  if (wanted.length === 0) return [];

  const lines = new Map<string, ScreenWord[]>();
  for (const word of words) {
    const line = lines.get(word.line) ?? [];
    line.push(word);
    lines.set(word.line, line);
  }

  const matches: TextMatch[] = [];
  for (const line of lines.values()) {
    line.sort((a, b) => a.left - b.left);
    for (let start = 0; start + wanted.length <= line.length; start++) {
      const run = line.slice(start, start + wanted.length);
      if (!run.every((word, i) => normalize(word.text) === wanted[i])) continue;
      matches.push(box(run, line));
    }
  }
  if (matches.length === 0 && wanted.length === 1 && wanted[0].length >= 3) {
    for (const line of lines.values()) {
      for (const word of line) {
        if (normalize(word.text).startsWith(wanted[0])) matches.push(box([word], line));
      }
    }
  }
  return matches.sort((a, b) => a.y - b.y || a.x - b.x);
}

function box(run: ScreenWord[], line: ScreenWord[]): TextMatch {
  const left = Math.min(...run.map((w) => w.left));
  const top = Math.min(...run.map((w) => w.top));
  const right = Math.max(...run.map((w) => w.left + w.width));
  const bottom = Math.max(...run.map((w) => w.top + w.height));
  return {
    text: run.map((w) => w.text).join(' '),
    line: line.map((w) => w.text).join(' '),
    x: (left + right) / 2,
    y: (top + bottom) / 2,
    width: right - left,
    height: bottom - top,
  };
}
