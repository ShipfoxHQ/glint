import type {PostgresDatabase} from '@glint/node-database';
import {sql} from 'drizzle-orm';
import {AccountsPersistenceError} from '../core/errors.js';
import type {MembershipProjectionRepository} from '../core/ports.js';
import type {MembershipProjection} from '../core/types.js';
import {membershipFromRow, requiredRow} from './mapping.js';
import {postgresCode} from './postgres-error.js';

export class PostgresMembershipProjectionRepository implements MembershipProjectionRepository {
  constructor(readonly database: PostgresDatabase) {}
  async projectFromProviderAccess(
    transaction: Parameters<MembershipProjectionRepository['projectFromProviderAccess']>[0],
    input: Omit<MembershipProjection, 'id'>,
  ): Promise<MembershipProjection> {
    try {
      return await this.database.useTransaction(transaction, async (tx) => {
        const result = await tx.execute<Record<string, unknown>>(
          sql`INSERT INTO accounts_memberships (account_id, identity_id, provider_role, role, state, verified_at, lease_expires_at) VALUES (${input.accountId}, ${input.identityId}, ${input.providerRole ?? null}, ${input.role}, ${input.state}, ${input.verifiedAt ?? null}, ${input.leaseExpiresAt ?? null}) ON CONFLICT (account_id, identity_id) DO UPDATE SET provider_role = EXCLUDED.provider_role, role = EXCLUDED.role, state = EXCLUDED.state, verified_at = EXCLUDED.verified_at, lease_expires_at = EXCLUDED.lease_expires_at, updated_at = now() RETURNING *`,
        );
        return membershipFromRow(requiredRow(result.rows));
      });
    } catch (error) {
      if (postgresCode(error) === '23505')
        throw new AccountsPersistenceError(
          'ACCOUNT_CONFLICT',
          'Membership projection could not be updated.',
        );
      throw error;
    }
  }
  listForIdentity(
    transaction: Parameters<MembershipProjectionRepository['listForIdentity']>[0],
  ): Promise<readonly MembershipProjection[]> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM accounts_memberships ORDER BY account_id, id`,
      );
      return result.rows.map(membershipFromRow);
    });
  }
  findForAccountIdentity(
    transaction: Parameters<MembershipProjectionRepository['findForAccountIdentity']>[0],
    accountId: string,
    identityId: string,
  ): Promise<MembershipProjection | undefined> {
    return this.database.useTransaction(transaction, async (tx) => {
      const result = await tx.execute<Record<string, unknown>>(
        sql`SELECT * FROM accounts_memberships WHERE account_id = ${accountId} AND identity_id = ${identityId} LIMIT 1`,
      );
      return result.rows[0] ? membershipFromRow(result.rows[0]) : undefined;
    });
  }
}
