import { describe, expect, it } from 'vitest';
import { imageCells } from './image-size.js';

const cell = { width: 10, height: 20 };

describe('imageCells', () => {
  it('takes the cells the picture covers at its own size', () => {
    expect(imageCells(200, 100, cell, 80, 24)).toEqual({ cols: 20, rows: 5 });
  });

  it('shrinks a picture to the width, keeping its proportions', () => {
    expect(imageCells(1600, 400, cell, 80, 24)).toEqual({ cols: 80, rows: 10 });
  });

  it('shrinks a picture to the height, keeping its proportions', () => {
    expect(imageCells(400, 1600, cell, 80, 24)).toEqual({ cols: 12, rows: 24 });
  });
});
