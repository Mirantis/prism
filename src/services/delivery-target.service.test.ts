import { describe, it, expect } from 'vitest';
import { isValidDeliverTo, parseCommaList } from './delivery-target.service';

describe('parseCommaList', () => {
  it('splits and trims, dropping empties', () => {
    expect(parseCommaList(' push, pull_request ,,')).toEqual(['push', 'pull_request']);
    expect(parseCommaList(null)).toEqual([]);
    expect(parseCommaList('')).toEqual([]);
  });
});

describe('isValidDeliverTo', () => {
  it('accepts only known deliver targets', () => {
    expect(isValidDeliverTo('all')).toBe(true);
    expect(isValidDeliverTo('chat')).toBe(true);
    expect(isValidDeliverTo('slack')).toBe(true);
    expect(isValidDeliverTo('teams')).toBe(true);
    expect(isValidDeliverTo('none')).toBe(true);
    expect(isValidDeliverTo('log')).toBe(false);
  });
});
