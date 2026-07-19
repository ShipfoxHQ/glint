import {describe, expect, it} from '@shipfox/vitest/vi';
import {validateReturnLocation} from './return-location.js';

const options = {webAppUrl: 'https://app.glint.test/dashboard'};

describe('validateReturnLocation', () => {
  it('accepts paths and exact-origin URLs', () => {
    expect(validateReturnLocation('/projects', options)).toBe('https://app.glint.test/projects');
    expect(validateReturnLocation('https://app.glint.test/settings', options)).toBe(
      'https://app.glint.test/settings',
    );
  });

  it('falls back to the application URL for unsafe locations', () => {
    for (const location of [
      '//evil.test',
      '/\\evil.test',
      'https://evil.test',
      'javascript:alert(1)',
      '/hello\u0000world',
    ]) {
      expect(validateReturnLocation(location, options)).toBe('https://app.glint.test/dashboard');
    }
  });
});
