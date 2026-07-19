import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import type {SessionRepository} from '../core/ports.js';
import type {Session} from '../core/types.js';
import {requiredRow, sessionFromRow} from './mapping.js';

export class PostgresSessionRepository implements SessionRepository {
  constructor(readonly database: PostgresDatabase) {}
  create(
    transaction: Parameters<SessionRepository['create']>[0],
    input: Omit<Session, 'id' | 'createdAt' | 'lastSeenAt' | 'revokedAt' | 'updatedAt'>,
  ): Promise<Session> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`INSERT INTO auth_sessions (identity_id, token_digest, absolute_expires_at, inactivity_expires_at) VALUES (${input.identityId}, ${input.tokenDigest}, ${input.absoluteExpiresAt}, ${input.inactivityExpiresAt}) RETURNING *`,
      );
      return sessionFromRow(requiredRow(result.rows));
    });
  }
  findByTokenDigest(
    transaction: Parameters<SessionRepository['findByTokenDigest']>[0],
    tokenDigest: string,
    now: Date,
  ): Promise<Session | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM auth_sessions WHERE token_digest = ${tokenDigest} AND revoked_at IS NULL AND absolute_expires_at > ${now} AND inactivity_expires_at > ${now}`,
      );
      return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
    });
  }
  touch(
    transaction: Parameters<SessionRepository['touch']>[0],
    id: string,
    now: Date,
    inactivityExpiresAt: Date,
  ): Promise<Session | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      // Concurrent or stale requests must never revive an expired session or move its lease backward.
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE auth_sessions SET last_seen_at = GREATEST(last_seen_at, ${now}), inactivity_expires_at = GREATEST(inactivity_expires_at, ${inactivityExpiresAt}), updated_at = now() WHERE id = ${id} AND revoked_at IS NULL AND absolute_expires_at > ${now} AND inactivity_expires_at > ${now} RETURNING *`,
      );
      return result.rows[0] ? sessionFromRow(result.rows[0]) : undefined;
    });
  }
  async revoke(
    transaction: Parameters<SessionRepository['revoke']>[0],
    id: string,
    now: Date,
  ): Promise<void> {
    await this.database.useTransaction(transaction, (tx) =>
      tx
        .execute(
          sql`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ${now}), updated_at = now() WHERE id = ${id}`,
        )
        .then(() => undefined),
    );
  }
  async revokeAllForIdentity(
    transaction: Parameters<SessionRepository['revokeAllForIdentity']>[0],
    identityId: string,
    now: Date,
  ): Promise<void> {
    await this.database.useTransaction(transaction, (tx) =>
      tx
        .execute(
          sql`UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, ${now}), updated_at = now() WHERE identity_id = ${identityId}`,
        )
        .then(() => undefined),
    );
  }
}
