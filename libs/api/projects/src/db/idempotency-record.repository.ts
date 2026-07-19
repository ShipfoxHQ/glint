import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import type {IdempotencyRecordRepository} from '../core/ports.js';
import type {IdempotencyRecord} from '../core/types.js';
import {idempotencyRecordFromRow, requiredRow} from './mapping.js';

export class PostgresIdempotencyRecordRepository implements IdempotencyRecordRepository {
  constructor(readonly database: PostgresDatabase) {}
  claim(
    transaction: Parameters<IdempotencyRecordRepository['claim']>[0],
    input: Omit<IdempotencyRecord, 'id' | 'createdAt' | 'updatedAt' | 'resultReference'>,
  ): Promise<IdempotencyRecord> {
    return this.database.useTransaction(transaction, async (tx) => {
      const inserted = await tx.execute<Record<string, unknown>>(
        sql`INSERT INTO idempotency_records (account_id, actor, route, idempotency_key, request_digest, expires_at) VALUES (${input.accountId}, ${input.actor}, ${input.route}, ${input.idempotencyKey}, ${input.requestDigest}, ${input.expiresAt}) ON CONFLICT (account_id, actor, route, idempotency_key) DO NOTHING RETURNING *`,
      );
      if (inserted.rows[0]) return idempotencyRecordFromRow(inserted.rows[0]);
      const selected = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM idempotency_records WHERE actor = ${input.actor} AND route = ${input.route} AND idempotency_key = ${input.idempotencyKey}`,
      );
      return idempotencyRecordFromRow(requiredRow(selected.rows));
    });
  }
  findByKey(
    transaction: Parameters<IdempotencyRecordRepository['findByKey']>[0],
    actor: string,
    route: string,
    idempotencyKey: string,
  ): Promise<IdempotencyRecord | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM idempotency_records WHERE actor = ${actor} AND route = ${route} AND idempotency_key = ${idempotencyKey}`,
      );
      return result.rows[0] ? idempotencyRecordFromRow(result.rows[0]) : undefined;
    });
  }
}
