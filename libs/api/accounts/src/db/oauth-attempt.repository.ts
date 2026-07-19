import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import type {OAuthAttemptRepository} from '../core/ports.js';
import type {OAuthAttempt} from '../core/types.js';
import {oauthAttemptFromRow, requiredRow} from './mapping.js';

export class PostgresOAuthAttemptRepository implements OAuthAttemptRepository {
  constructor(readonly database: PostgresDatabase) {}
  create(
    transaction: Parameters<OAuthAttemptRepository['create']>[0],
    input: Omit<OAuthAttempt, 'id' | 'consumedAt'>,
  ): Promise<OAuthAttempt> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`INSERT INTO auth_oauth_attempts (state_digest, pkce_verifier, return_location, environment, expires_at) VALUES (${input.stateDigest}, ${input.pkceVerifier}, ${input.returnLocation}, ${input.environment}, ${input.expiresAt}) RETURNING *`,
      );
      return oauthAttemptFromRow(requiredRow(result.rows));
    });
  }
  consumeByStateDigest(
    transaction: Parameters<OAuthAttemptRepository['consumeByStateDigest']>[0],
    stateDigest: string,
    now: Date,
  ): Promise<OAuthAttempt | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`UPDATE auth_oauth_attempts SET consumed_at = ${now}, updated_at = now() WHERE state_digest = ${stateDigest} AND consumed_at IS NULL AND expires_at > ${now} RETURNING *`,
      );
      return result.rows[0] ? oauthAttemptFromRow(result.rows[0]) : undefined;
    });
  }
}
