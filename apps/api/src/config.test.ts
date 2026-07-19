import {describe, expect, it} from '@shipfox/vitest/vi';
import {loadApiEnvironment} from './config.js';

describe('API authentication environment', () => {
  it('keeps local OAuth usable with non-secure development cookies', () => {
    expect(loadApiEnvironment({}).GLINT_SESSION_COOKIE_SECURE).toBe(false);
  });

  it('rejects development signing keys and insecure cookies outside development', () => {
    expect(() => loadApiEnvironment({GLINT_ENVIRONMENT: 'production'})).toThrow(
      'Production security invariant',
    );
  });
});
