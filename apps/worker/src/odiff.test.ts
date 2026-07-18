import {describe, expect, it} from '@shipfox/vitest/vi';
import {isOdiffVersion} from './odiff.js';

describe('ODiff version', () => {
  it('accepts the pinned ODiff release output', () => {
    expect(isOdiffVersion('odiff 4.3.8 - SIMD image comparison tool')).toBe(true);
  });

  it.each([
    'odiff 4.3.8.1',
    'odiff v4.3.8-beta',
    'odiff 14.3.8',
    'odiff 4.3.80',
  ])('rejects %s', (output) => {
    expect(isOdiffVersion(output)).toBe(false);
  });
});
