import {describe, expect, it} from '@shipfox/vitest/vi';
import {
  generateOAuthState,
  generatePkce,
  generateSessionToken,
  oauthStateDigest,
  sessionTokenDigest,
} from './session-token.js';

describe('session token primitives', () => {
  it('generates 256-bit opaque base64url values without padding', () => {
    for (const value of [generateSessionToken(), generateOAuthState()]) {
      expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(value).not.toContain('=');
    }
  });

  it('domain-separates session and OAuth state digests', () => {
    expect(sessionTokenDigest('same-value', 'secret')).not.toBe(
      oauthStateDigest('same-value', 'secret'),
    );
  });

  it('creates an S256 PKCE challenge', async () => {
    const pkce = generatePkce();
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pkce.verifier));
    expect(pkce.challenge).toBe(Buffer.from(digest).toString('base64url'));
  });
});
