import type {
  VcsAuthorizationResult,
  VcsIdentityProvider,
  VcsProviderError,
} from '@glint/api-vcs-core';
import type {Database} from '@glint/node-database';
import {AuthenticationError} from './authentication-error.js';
import type {
  OAuthAttemptRepository,
  ProviderIdentityRepository,
  SessionRepository,
} from './ports.js';
import {validateReturnLocation} from './return-location.js';
import {
  generateOAuthState,
  generatePkce,
  generateSessionToken,
  oauthStateDigest,
  sessionTokenDigest,
} from './session-token.js';
import type {ProviderIdentity, Session} from './types.js';

export interface AuthModuleConfig {
  readonly absoluteTtlSeconds: number;
  readonly attemptTtlSeconds: number;
  readonly authorizeUrl: string;
  readonly callbackUrl: string;
  readonly clientId: string;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly environment: string;
  readonly inactivityTtlSeconds: number;
  readonly mutationPreflightHeader: string;
  readonly oauthScopes: string;
  readonly allowedOrigins: readonly string[];
  readonly sessionTokenSecret: string;
  readonly webAppUrl: string;
}

export interface AuthenticationService {
  startLogin(input: {readonly returnTo?: string}): Promise<{
    readonly authorizeUrl: string;
    readonly state: string;
  }>;
  completeCallback(input: {
    readonly code?: string;
    readonly errorParam?: string;
    readonly preAuthCookieState?: string;
    readonly state?: string;
  }): Promise<{readonly returnLocation: string; readonly session: Session; readonly token: string}>;
  resolveSession(input: {readonly token?: string}): Promise<Session>;
  findIdentity(identityId: string): Promise<ProviderIdentity | undefined>;
  rotateSession(input: {
    readonly token: string;
  }): Promise<{readonly session: Session; readonly token: string}>;
  logout(input: {readonly sessionId: string}): Promise<void>;
  logoutAll(input: {readonly identityId: string}): Promise<void>;
}

function plusSeconds(now: Date, seconds: number): Date {
  return new Date(now.getTime() + seconds * 1_000);
}

function minDate(left: Date, right: Date): Date {
  return left.getTime() < right.getTime() ? left : right;
}

function mapVcsError(error: unknown): AuthenticationError {
  if (typeof error !== 'object' || error === null || !('code' in error)) {
    return new AuthenticationError('IDENTITY_PROVIDER_UNAVAILABLE');
  }
  const code = (error as VcsProviderError).code;
  return code === 'access_revocation'
    ? new AuthenticationError('OAUTH_EXCHANGE_FAILED')
    : new AuthenticationError('IDENTITY_PROVIDER_UNAVAILABLE');
}

export function createAuthenticationService(options: {
  readonly clock?: () => Date;
  readonly config: AuthModuleConfig;
  readonly database: Database;
  readonly identityProvider: VcsIdentityProvider;
  readonly oauthAttempts: OAuthAttemptRepository;
  readonly providerIdentities: ProviderIdentityRepository;
  readonly sessions: SessionRepository;
}): AuthenticationService {
  const clock = options.clock ?? (() => new Date());
  const createSession = async (identityId: string, now: Date, absoluteExpiresAt?: Date) => {
    const token = generateSessionToken();
    const absolute = absoluteExpiresAt ?? plusSeconds(now, options.config.absoluteTtlSeconds);
    const inactivity = minDate(absolute, plusSeconds(now, options.config.inactivityTtlSeconds));
    const session = await options.database.transaction((transaction) =>
      options.sessions.create(transaction, {
        identityId,
        tokenDigest: sessionTokenDigest(token, options.config.sessionTokenSecret),
        absoluteExpiresAt: absolute,
        inactivityExpiresAt: inactivity,
      }),
    );
    return {session, token};
  };
  const resolveSession = async ({token}: {readonly token?: string}) => {
    if (!token) throw new AuthenticationError('SESSION_EXPIRED');
    const now = clock();
    const target = plusSeconds(now, options.config.inactivityTtlSeconds);
    const session = await options.database.transaction((transaction) =>
      options.sessions.touchByTokenDigest(
        transaction,
        sessionTokenDigest(token, options.config.sessionTokenSecret),
        now,
        target,
      ),
    );
    if (!session) throw new AuthenticationError('SESSION_EXPIRED');
    return session;
  };

  return {
    async startLogin({returnTo}) {
      const now = clock();
      const state = generateOAuthState();
      const pkce = generatePkce();
      const returnLocation = validateReturnLocation(returnTo, {
        webAppUrl: options.config.webAppUrl,
      });
      await options.database.transaction((transaction) =>
        options.oauthAttempts.create(transaction, {
          stateDigest: oauthStateDigest(state, options.config.sessionTokenSecret),
          pkceVerifier: pkce.verifier,
          returnLocation,
          environment: options.config.environment,
          expiresAt: plusSeconds(now, options.config.attemptTtlSeconds),
        }),
      );
      const authorizeUrl = new URL(options.config.authorizeUrl);
      authorizeUrl.searchParams.set('client_id', options.config.clientId);
      authorizeUrl.searchParams.set('redirect_uri', options.config.callbackUrl);
      authorizeUrl.searchParams.set('scope', options.config.oauthScopes);
      authorizeUrl.searchParams.set('state', state);
      authorizeUrl.searchParams.set('code_challenge', pkce.challenge);
      authorizeUrl.searchParams.set('code_challenge_method', 'S256');
      return {authorizeUrl: authorizeUrl.toString(), state};
    },

    async completeCallback({code, errorParam, preAuthCookieState, state}) {
      if (errorParam) throw new AuthenticationError('OAUTH_ACCESS_DENIED');
      if (!state || !code || !preAuthCookieState || preAuthCookieState !== state) {
        throw new AuthenticationError('OAUTH_STATE_INVALID');
      }
      const now = clock();
      const attempt = await options.database.transaction((transaction) =>
        options.oauthAttempts.consumeByStateDigest(
          transaction,
          oauthStateDigest(state, options.config.sessionTokenSecret),
          now,
        ),
      );
      if (!attempt || attempt.environment !== options.config.environment) {
        throw new AuthenticationError('OAUTH_STATE_INVALID');
      }
      let authorization: VcsAuthorizationResult;
      try {
        authorization = await options.identityProvider.exchangeAuthorization({
          authorizationCode: code,
          codeVerifier: attempt.pkceVerifier,
          redirectUri: options.config.callbackUrl,
        });
      } catch (error) {
        throw mapVcsError(error);
      }
      const identity = await options.database.transaction((transaction) =>
        options.providerIdentities.upsertByProviderUser(transaction, {
          provider: authorization.identity.provider,
          providerUserId: authorization.identity.id,
          login: authorization.identity.login,
          ...(authorization.identity.displayName
            ? {displayName: authorization.identity.displayName}
            : {}),
          ...(authorization.identity.avatarUrl
            ? {avatarUrl: authorization.identity.avatarUrl}
            : {}),
        }),
      );
      const created = await createSession(identity.id, now);
      return {...created, returnLocation: attempt.returnLocation};
    },

    resolveSession,

    findIdentity(identityId) {
      return options.database.transaction((transaction) =>
        options.providerIdentities.findById(transaction, identityId),
      );
    },

    async rotateSession({token}) {
      const now = clock();
      return await options.database.transaction(async (transaction) => {
        const current = await options.sessions.touchByTokenDigest(
          transaction,
          sessionTokenDigest(token, options.config.sessionTokenSecret),
          now,
          plusSeconds(now, options.config.inactivityTtlSeconds),
        );
        if (!current) throw new AuthenticationError('SESSION_EXPIRED');
        const nextToken = generateSessionToken();
        const session = await options.sessions.create(transaction, {
          identityId: current.identityId,
          tokenDigest: sessionTokenDigest(nextToken, options.config.sessionTokenSecret),
          absoluteExpiresAt: current.absoluteExpiresAt,
          inactivityExpiresAt: minDate(
            current.absoluteExpiresAt,
            plusSeconds(now, options.config.inactivityTtlSeconds),
          ),
        });
        await options.sessions.revoke(transaction, current.id, now);
        return {session, token: nextToken};
      });
    },

    logout({sessionId}) {
      return options.database.transaction((transaction) =>
        options.sessions.revoke(transaction, sessionId, clock()),
      );
    },

    logoutAll({identityId}) {
      return options.database.transaction((transaction) =>
        options.sessions.revokeAllForIdentity(transaction, identityId, clock()),
      );
    },
  };
}
