import {describe, expect, it} from '@shipfox/vitest/vi';
import {databaseErrorCode} from './postgres.js';

describe('databaseErrorCode', () => {
  it('walks nested causes and terminates safely on cycles', () => {
    expect(databaseErrorCode({cause: {code: '23505'}})).toBe('23505');
    const cycle: {cause?: unknown} = {};
    cycle.cause = cycle;
    expect(databaseErrorCode(cycle)).toBeUndefined();
  });
});
