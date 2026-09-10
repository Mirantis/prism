import { describe, expect, it } from 'vitest';
import { findText, parseTsv, readLines } from '../screen-text';

// Rows Tesseract produced for the XFCE Applications menu, grabbed at twice the size:
// header, then level-5 word rows (level page block par line word left top width height conf text).
const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t1\t1\t1\t1\t56\t177\t60\t19\t96.66\tFile',
  '5\t1\t1\t1\t1\t2\t136\t179\t107\t23\t95.91\tManager',
  '5\t1\t1\t1\t2\t1\t56\t227\t60\t19\t96.49\tMail',
  '5\t1\t1\t1\t2\t2\t136\t227\t91\t19\t96.18\tReader',
  '5\t1\t1\t1\t3\t1\t56\t432\t76\t18\t96.84\tGames',
  '5\t1\t1\t1\t4\t1\t57\t635\t43\t23\t94.18\tLog',
  '5\t1\t1\t1\t4\t2\t120\t634\t42\t18\t79.84\tout',
  '5\t1\t2\t1\t1\t1\t1145\t6\t15\t14\t12.0\t«&',
  '4\t1\t1\t1\t1\t0\t56\t177\t187\t25\t-1\t',
].join('\n');

describe('parseTsv', () => {
  it('keeps confident words only, divided back to screen pixels', () => {
    const words = parseTsv(TSV, 2);
    expect(words.map((w) => w.text)).toEqual(['File', 'Manager', 'Mail', 'Reader', 'Games', 'Log', 'out']);
    expect(words[2]).toMatchObject({ left: 28, top: 113.5, width: 30, height: 9.5 });
  });
});

describe('readLines', () => {
  it('joins each line left to right and orders lines top to bottom', () => {
    expect(readLines(parseTsv(TSV, 2))).toEqual(['File Manager', 'Mail Reader', 'Games', 'Log out']);
  });
});

describe('findText', () => {
  const words = parseTsv(TSV, 2);

  it('finds a phrase as consecutive words on one line and centres on the run', () => {
    const [match] = findText(words, 'Mail Reader');
    expect(match.text).toBe('Mail Reader');
    expect(Math.round(match.x)).toBe(71);
    expect(Math.round(match.y)).toBe(118);
  });

  it('ignores case and punctuation in the query and on screen', () => {
    expect(findText(words, 'log out.')).toHaveLength(1);
    expect(findText(words, 'FILE MANAGER')).toHaveLength(1);
  });

  it('does not join words from different lines', () => {
    expect(findText(words, 'Manager Mail')).toHaveLength(0);
  });

  it('matches a single word that a label starts with, when nothing matches whole', () => {
    expect(findText(words, 'Gam')).toHaveLength(1);
    expect(findText(words, 'Ga')).toHaveLength(0);
  });

  it('answers empty for text that is not on screen', () => {
    expect(findText(words, 'Web Browser')).toHaveLength(0);
  });
});
