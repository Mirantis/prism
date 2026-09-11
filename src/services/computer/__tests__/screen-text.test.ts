import { describe, expect, it } from 'vitest';
import { findText, parseTsv, readLines } from '../screen-text';

// Rows Tesseract produced for the About dialog on the desktop, grabbed at twice the size:
// header, then level page block par line word left top width height conf text. Level 5
// rows are words; the two rows before them are what a grab also returns and this drops.
const TSV = [
  'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext',
  '5\t1\t2\t1\t1\t6\t1260\t88\t8\t8\t29.915310\t.',
  '4\t1\t5\t1\t1\t0\t1724\t262\t309\t21\t-1\t',
  '5\t1\t5\t1\t2\t1\t1707\t310\t30\t18\t95.482529\tOS',
  '5\t1\t5\t1\t2\t2\t1756\t310\t60\t18\t96.713371\tName',
  '5\t1\t5\t1\t2\t3\t1843\t308\t94\t21\t96.563179\tDebian',
  '5\t1\t5\t1\t2\t4\t1955\t308\t142\t21\t96.098534\tGNU/Linux',
  '5\t1\t5\t1\t2\t5\t2116\t309\t29\t20\t96.214478\t12',
  '5\t1\t5\t1\t2\t6\t2166\t308\t152\t26\t96.214478\t(bookworm)',
  '5\t1\t5\t1\t3\t1\t1707\t356\t30\t18\t96.452904\tOS',
  '5\t1\t5\t1\t3\t2\t1755\t356\t61\t24\t95.875023\tType',
  '5\t1\t5\t1\t3\t3\t1843\t354\t93\t21\t96.339973\t64-bit',
  '5\t1\t5\t1\t4\t1\t1644\t400\t172\t20\t96.417061\tDistributor',
  '5\t1\t5\t1\t4\t2\t1843\t400\t94\t21\t96.466576\tDebian',
  '5\t1\t6\t1\t1\t2\t1627\t470\t61\t20\t96.730331\tXfce',
  '5\t1\t6\t1\t1\t3\t1706\t470\t110\t20\t96.156990\tVersion',
  '5\t1\t6\t1\t1\t4\t1843\t471\t62\t20\t96.215294\t4.18',
  '5\t1\t6\t1\t2\t1\t1643\t518\t47\t18\t92.887886\tGTK',
  '5\t1\t6\t1\t2\t2\t1706\t516\t110\t20\t95.718300\tVersion',
  '5\t1\t6\t1\t2\t3\t1843\t517\t110\t20\t95.718300\t3.24.38',
].join('\n');

describe('parseTsv', () => {
  it('keeps confident words only, divided back to screen pixels', () => {
    const words = parseTsv(TSV, 2);
    expect(words.map((w) => w.text)).toEqual([
      'OS', 'Name', 'Debian', 'GNU/Linux', '12', '(bookworm)',
      'OS', 'Type', '64-bit',
      'Distributor', 'Debian',
      'Xfce', 'Version', '4.18',
      'GTK', 'Version', '3.24.38',
    ]);
    expect(words[2]).toMatchObject({ left: 921.5, top: 154, width: 47, height: 10.5 });
  });
});

describe('readLines', () => {
  it('joins each line left to right and orders lines top to bottom', () => {
    expect(readLines(parseTsv(TSV, 2))).toEqual([
      'OS Name Debian GNU/Linux 12 (bookworm)',
      'OS Type 64-bit',
      'Distributor Debian',
      'Xfce Version 4.18',
      'GTK Version 3.24.38',
    ]);
  });
});

describe('findText', () => {
  const words = parseTsv(TSV, 2);

  it('finds a phrase as consecutive words on one line and centres on the run', () => {
    const [match] = findText(words, 'GNU/Linux 12');
    expect(match.text).toBe('GNU/Linux 12');
    expect(Math.round(match.x)).toBe(1025);
    expect(Math.round(match.y)).toBe(159);
  });

  it('ignores case and punctuation in the query and on screen', () => {
    expect(findText(words, 'debian gnu/linux')).toHaveLength(1);
    expect(findText(words, 'OS NAME')).toHaveLength(1);
  });

  it('does not join words from different lines', () => {
    expect(findText(words, 'Debian Xfce')).toHaveLength(0);
  });

  it('matches a single word that a label starts with, when nothing matches whole', () => {
    expect(findText(words, 'Distrib')).toHaveLength(1);
    expect(findText(words, 'Di')).toHaveLength(0);
  });

  it('answers empty for text that is not on screen', () => {
    expect(findText(words, 'Web Browser')).toHaveLength(0);
  });
});
