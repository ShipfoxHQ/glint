import type {PostgresDatabase} from '@glint/node-database';
import {and, eq, gt, isNull, sql} from 'drizzle-orm';
import type {SessionRepository} from '../core/ports.js';
import type {Session} from '../core/types.js';
import {sessions} from './schema/auth.js';

function sessionFromDatabaseRow(row: typeof sessions.$inferSelect): Session {
  return {
    id: row.id,
    identityId: row.identityId,
    tokenDigest: row.tokenDigest,
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    inactivityExpiresAt: row.inactivityExpiresAt,
    ...(row.revokedAt ? {revokedAt: row.revokedAt} : {}),
    updatedAt: row.updatedAt,
  };
}

function activeSessionWhere(now: Date) {
  return and(
    isNull(sessions.revokedAt),
    gt(sessions.absoluteExpiresAt, now),
    gt(sessions.inactivityExpiresAt, now),
  );
}

export class PostgresSessionRepository implements SessionRepository {
  constructor(readonly database: PostgresDatabase) {}
  create(
    transaction: Parameters<SessionRepository['create']>[0],
    input: Omit<Session, 'id' | 'createdAt' | 'lastSeenAt' | 'revokedAt' | 'updatedAt'>,
  ): Promise<Session> {
    return this.database.useTransaction(transaction, async (tx) => {
      const [session] = await tx
        .insert(sessions)
        .values({
          identityId: input.identityId,
          tokenDigest: input.tokenDigest,
          absoluteExpiresAt: input.absoluteExpiresAt,
          inactivityExpiresAt: input.inactivityExpiresAt,
        })
        .returning();
      if (!session) throw new Error('Expected session creation to return a row.');
      return sessionFromDatabaseRow(session);
    });
  }
  findByTokenDigest(
    transaction: Parameters<SessionRepository['findByTokenDigest']>[0],
    tokenDigest: string,
    now: Date,
  ): Promise<Session | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const [session] = await tx
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenDigest, tokenDigest), activeSessionWhere(now)));
      return session ? sessionFromDatabaseRow(session) : undefined;
    });
  }
  touch(
    transaction: Parameters<SessionRepository['touch']>[0],
    id: string,
    now: Date,
    inactivityExpiresAt: Date,
  ): Promise<Session | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const [session] = await tx
        .update(sessions)
        .set({
          lastSeenAt: sql<Date>`greatest(${sessions.lastSeenAt}, ${now})`,
          inactivityExpiresAt: sql<Date>`greatest(${sessions.inactivityExpiresAt}, ${inactivityExpiresAt})`,
          updatedAt: sql<Date>`now()`,
        })
        .where(and(eq(sessions.id, id), activeSessionWhere(now)))
        .returning();
      return session ? sessionFromDatabaseRow(session) : undefined;
    });
  }
  touchByTokenDigest(
    transaction: Parameters<SessionRepository['touchByTokenDigest']>[0],
    tokenDigest: string,
    now: Date,
    inactivityTarget: Date,
  ): Promise<Session | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      // A single statement validates and slides the session, so no stale read can revive it.
      const [session] = await tx
        .update(sessions)
        .set({
          lastSeenAt: sql<Date>`greatest(${sessions.lastSeenAt}, ${now})`,
          inactivityExpiresAt: sql<Date>`case
            when ${sessions.inactivityExpiresAt} < least(${inactivityTarget}, ${sessions.absoluteExpiresAt}) - interval '5 minutes'
              then least(${inactivityTarget}, ${sessions.absoluteExpiresAt})
            else ${sessions.inactivityExpiresAt}
          end`,
          updatedAt: sql<Date>`now()`,
        })
        .where(and(eq(sessions.tokenDigest, tokenDigest), activeSessionWhere(now)))
        .returning();
      return session ? sessionFromDatabaseRow(session) : undefined;
    });
  }
  async revoke(
    transaction: Parameters<SessionRepository['revoke']>[0],
    id: string,
    now: Date,
  ): Promise<void> {
    await this.database.useTransaction(transaction, async (tx) => {
      await tx
        .update(sessions)
        .set({
          revokedAt: sql<Date>`coalesce(${sessions.revokedAt}, ${now})`,
          updatedAt: sql<Date>`now()`,
        })
        .where(eq(sessions.id, id));
    });
  }
  async revokeAllForIdentity(
    transaction: Parameters<SessionRepository['revokeAllForIdentity']>[0],
    identityId: string,
    now: Date,
  ): Promise<void> {
    await this.database.useTransaction(transaction, async (tx) => {
      await tx
        .update(sessions)
        .set({
          revokedAt: sql<Date>`coalesce(${sessions.revokedAt}, ${now})`,
          updatedAt: sql<Date>`now()`,
        })
        .where(eq(sessions.identityId, identityId));
    });
  }
}
