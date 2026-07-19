import type {DatabaseTransaction} from '@glint/node-database';
import type {
  Account,
  Installation,
  MembershipProjection,
  OAuthAttempt,
  ProviderIdentity,
  Session,
} from './types.js';

export interface ProviderIdentityRepository {
  upsertByProviderUser(
    transaction: DatabaseTransaction,
    input: Omit<ProviderIdentity, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<ProviderIdentity>;
  findById(transaction: DatabaseTransaction, id: string): Promise<ProviderIdentity | undefined>;
}
export interface OAuthAttemptRepository {
  create(
    transaction: DatabaseTransaction,
    input: Omit<OAuthAttempt, 'id' | 'consumedAt'>,
  ): Promise<OAuthAttempt>;
  consumeByStateDigest(
    transaction: DatabaseTransaction,
    stateDigest: string,
    now: Date,
  ): Promise<OAuthAttempt | undefined>;
}
export interface SessionRepository {
  create(
    transaction: DatabaseTransaction,
    input: Omit<Session, 'id' | 'createdAt' | 'lastSeenAt' | 'revokedAt' | 'updatedAt'>,
  ): Promise<Session>;
  findByTokenDigest(
    transaction: DatabaseTransaction,
    tokenDigest: string,
    now: Date,
  ): Promise<Session | undefined>;
  touch(
    transaction: DatabaseTransaction,
    id: string,
    now: Date,
    inactivityExpiresAt: Date,
  ): Promise<Session | undefined>;
  touchByTokenDigest(
    transaction: DatabaseTransaction,
    tokenDigest: string,
    now: Date,
    inactivityTarget: Date,
  ): Promise<Session | undefined>;
  revoke(transaction: DatabaseTransaction, id: string, now: Date): Promise<void>;
  revokeAllForIdentity(
    transaction: DatabaseTransaction,
    identityId: string,
    now: Date,
  ): Promise<void>;
}
export interface AccountRepository {
  upsertByProviderNamespace(
    transaction: DatabaseTransaction,
    input: Omit<Account, 'id' | 'createdAt' | 'updatedAt'>,
  ): Promise<Account>;
  findById(transaction: DatabaseTransaction, id: string): Promise<Account | undefined>;
  listSummariesForIdentity(transaction: DatabaseTransaction): Promise<readonly Account[]>;
}
export interface InstallationRepository {
  linkCurrent(
    transaction: DatabaseTransaction,
    input: Omit<Installation, 'id' | 'suspendedAt' | 'removedAt'>,
  ): Promise<Installation>;
  findCurrentForAccount(transaction: DatabaseTransaction): Promise<Installation | undefined>;
  setState(
    transaction: DatabaseTransaction,
    id: string,
    state: Installation['state'],
    now: Date,
  ): Promise<Installation | undefined>;
}
export interface MembershipProjectionRepository {
  projectFromProviderAccess(
    transaction: DatabaseTransaction,
    input: Omit<MembershipProjection, 'id'>,
  ): Promise<MembershipProjection>;
  listForIdentity(transaction: DatabaseTransaction): Promise<readonly MembershipProjection[]>;
  findForAccountIdentity(
    transaction: DatabaseTransaction,
    accountId: string,
    identityId: string,
  ): Promise<MembershipProjection | undefined>;
}
