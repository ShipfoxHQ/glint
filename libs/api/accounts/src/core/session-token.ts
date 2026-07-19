import {createHash, createHmac, randomBytes} from 'node:crypto';

const SESSION_CONTEXT = 'glint.session.v1';
const OAUTH_STATE_CONTEXT = 'glint.oauth-state.v1';

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function generateOAuthState(): string {
  return randomBytes(32).toString('base64url');
}

/** Domain-separated HMAC digest; bearer values are never stored directly. */
export function digest(contextTag: string, value: string, secret: string): string {
  return createHmac('sha256', secret).update(`${contextTag}\0${value}`).digest('base64url');
}

export function sessionTokenDigest(token: string, secret: string): string {
  return digest(SESSION_CONTEXT, token, secret);
}

export function oauthStateDigest(state: string, secret: string): string {
  return digest(OAUTH_STATE_CONTEXT, state, secret);
}

export function generatePkce(): {readonly verifier: string; readonly challenge: string} {
  const verifier = randomBytes(32).toString('base64url');
  // GitHub currently ignores PKCE, but retaining it keeps the OAuth attempt portable and harmless.
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return {verifier, challenge};
}
