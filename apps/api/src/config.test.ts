import {describe, expect, it} from '@shipfox/vitest/vi';
import {loadApiEnvironment} from './config.js';

describe('API authentication environment', () => {
  it('keeps local OAuth usable with non-secure development cookies', () => {
    expect(loadApiEnvironment({}).GLINT_SESSION_COOKIE_SECURE).toBe(false);
    expect(loadApiEnvironment({}).GLINT_ACCOUNT_AUTHORIZATION_LEASE_TTL_SECONDS).toBe(900);
  });

  const secureProductionEnvironment = {
    GLINT_ENVIRONMENT: 'production',
    GLINT_SESSION_COOKIE_SECURE: 'true',
    GLINT_SESSION_TOKEN_SECRET: 'unique-session-secret',
    GLINT_COOKIE_SECRET: 'unique-cookie-secret',
  };

  it('rejects insecure session cookies outside development', () => {
    expect(() =>
      loadApiEnvironment({...secureProductionEnvironment, GLINT_SESSION_COOKIE_SECURE: 'false'}),
    ).toThrow('GLINT_SESSION_COOKIE_SECURE');
  });

  it('rejects the development session-token secret outside development', () => {
    expect(() =>
      loadApiEnvironment({
        ...secureProductionEnvironment,
        GLINT_SESSION_TOKEN_SECRET: 'development-session-token-secret-not-for-production',
      }),
    ).toThrow('GLINT_SESSION_TOKEN_SECRET');
  });

  it('rejects the development cookie-signing secret outside development', () => {
    expect(() =>
      loadApiEnvironment({
        ...secureProductionEnvironment,
        GLINT_COOKIE_SECRET: 'development-cookie-secret-not-for-production',
      }),
    ).toThrow('GLINT_COOKIE_SECRET');
  });
});
