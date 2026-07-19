import type {StructuredLogger} from '@glint/node-observability';
import {drizzle, type NodePgDatabase} from '@shipfox/node-drizzle';
import {
  closePostgresClient,
  createPostgresClient,
  type Pool,
  type PoolConfig,
} from '@shipfox/node-postgres';
import {sql} from 'drizzle-orm';
import type {NodePgTransaction} from 'drizzle-orm/node-postgres';
import type {TablesRelationalConfig} from 'drizzle-orm/relations';
import {type DatabaseEnvironment, loadDatabaseEnvironment} from './config.js';
import type {Database, DatabaseHealth, DatabaseTransaction, TransactionOptions} from './types.js';
import {
  MVP_DATABASE_POLICY,
  ReadOnlyTransactionError,
  StatementTimeoutError,
  TransactionStateError,
  validateTransactionOptions,
} from './types.js';

type EmptySchema = Record<string, never>;
export type PostgresDrizzleDatabase = NodePgDatabase<EmptySchema>;
export type PostgresDrizzleTransaction = NodePgTransaction<EmptySchema, TablesRelationalConfig>;

interface PostgresDatabaseOptions {
  readonly close?: () => Promise<void>;
  readonly clock?: () => number;
  readonly logger?: StructuredLogger;
  readonly pool: Pool;
}

export interface CreatePostgresDatabaseOptions {
  readonly environment?: DatabaseEnvironment;
  readonly logger?: StructuredLogger;
}

class GlintPostgresTransaction implements DatabaseTransaction {
  active = true;

  constructor(
    readonly id: string,
    readonly owner: PostgresDatabase,
    readonly drizzle: PostgresDrizzleTransaction,
  ) {}
}

/** Concrete PostgreSQL adapter behind Glint's provider-neutral transaction contract. */
export class PostgresDatabase implements Database {
  readonly drizzle: PostgresDrizzleDatabase;
  readonly #close: () => Promise<void>;
  readonly #clock: () => number;
  readonly #logger: StructuredLogger | undefined;
  readonly #pool: Pool;
  #health: DatabaseHealth;
  #nextTransactionId = 1;
  #recoveryVerification: Promise<void> | undefined;
  readonly #onPoolError = (error: Error): void => {
    this.#logger?.warn('PostgreSQL discarded an idle client after a connection error.', {
      ...databaseErrorAttributes(error),
      operation: 'idle',
    });
  };

  constructor(options: PostgresDatabaseOptions) {
    this.#pool = options.pool;
    this.drizzle = drizzle(options.pool);
    this.#close = options.close ?? (() => options.pool.end());
    this.#clock = options.clock ?? Date.now;
    this.#logger = options.logger;
    this.#health = {
      status: 'unavailable',
      checkedAtMs: this.#clock(),
      detail: 'PostgreSQL startup verification has not completed.',
    };
    this.#pool.on('error', this.#onPoolError);
  }

  /** Verifies the connection once at process startup and caches readiness for dependency-free probes. */
  async initialize(): Promise<void> {
    try {
      await this.#verifyConnection();
      this.#recordReady();
      this.#logger?.info('PostgreSQL connection is ready.');
    } catch (error) {
      this.#recordUnavailable('startup', error);
      throw error;
    }
  }

  async transaction<T>(
    operation: (transaction: DatabaseTransaction) => Promise<T>,
    options: TransactionOptions = {},
  ): Promise<T> {
    validateTransactionOptions(options);
    const statementTimeoutMs = options.statementTimeoutMs ?? MVP_DATABASE_POLICY.statementTimeoutMs;
    try {
      const result = await this.drizzle.transaction(
        async (drizzleTransaction) => {
          const transaction = new GlintPostgresTransaction(
            `postgres-${this.#nextTransactionId++}`,
            this,
            drizzleTransaction,
          );
          try {
            await drizzleTransaction.execute(sql`
              SELECT
                set_config('statement_timeout', ${`${statementTimeoutMs}ms`}, true),
                set_config('glint.identity_id', ${options.identity?.identityId ?? ''}, true),
                set_config('glint.account_id', ${options.tenant?.accountId ?? ''}, true)
            `);
            return await operation(transaction);
          } finally {
            transaction.active = false;
          }
        },
        {
          ...(options.isolation
            ? {isolationLevel: options.isolation.replaceAll('-', ' ') as IsolationLevel}
            : {}),
          ...(options.readOnly ? {accessMode: 'read only' as const} : {}),
        },
      );
      this.#recordReady();
      return result;
    } catch (error) {
      const mapped = mapPostgresError(error, {
        ...(options.readOnly === undefined ? {} : {readOnly: options.readOnly}),
        statementTimeoutMs,
      });
      if (isConnectionFailure(error)) this.#recordUnavailable('transaction', error);
      throw mapped;
    }
  }

  /** Uses the provider transaction without adding Drizzle to the neutral Database contract. */
  useTransaction<T>(
    transaction: DatabaseTransaction,
    operation: (drizzleTransaction: PostgresDrizzleTransaction) => Promise<T>,
  ): Promise<T> {
    const postgresTransaction = this.#activeTransaction(transaction);
    return operation(postgresTransaction.drizzle);
  }

  /**
   * Observes PostgreSQL operations outside Glint-managed transactions. Recovery from an
   * unavailable state requires a concrete connection probe rather than trusting the callback.
   */
  async runObserved<T>(operationName: string, operation: () => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await operation();
    } catch (error) {
      if (isConnectionFailure(error)) this.#recordUnavailable(operationName, error);
      throw error;
    }
    if (this.#health.status === 'unavailable') {
      await this.#verifyRecovery();
    } else {
      this.#recordReady();
    }
    return result;
  }

  /** Returns cached state and never opens a connection or wakes a suspended managed database. */
  health(): Promise<DatabaseHealth> {
    return Promise.resolve(structuredClone(this.#health));
  }

  /** Readiness-registry callback backed by cached state rather than a database query. */
  async assertReady(): Promise<void> {
    const health = await this.health();
    if (health.status === 'unavailable') {
      throw new Error(health.detail ?? 'PostgreSQL is unavailable.');
    }
  }

  async close(): Promise<void> {
    try {
      await this.#close();
    } finally {
      this.#pool.off('error', this.#onPoolError);
    }
  }

  #activeTransaction(transaction: DatabaseTransaction): GlintPostgresTransaction {
    if (
      !(transaction instanceof GlintPostgresTransaction) ||
      transaction.owner !== this ||
      !transaction.active
    ) {
      throw new TransactionStateError();
    }
    return transaction;
  }

  #recordReady(): void {
    this.#health = {status: 'ready', checkedAtMs: this.#clock()};
  }

  #recordUnavailable(operation: string, error: unknown): void {
    const detail = describeDatabaseError(error);
    this.#health = {status: 'unavailable', checkedAtMs: this.#clock(), detail};
    this.#logger?.error('PostgreSQL connection is unavailable.', {
      operation,
      ...databaseErrorAttributes(error),
    });
  }

  async #verifyConnection(): Promise<void> {
    const result = await this.#pool.query<{lc_messages: string}>(
      "SELECT current_setting('lc_messages') AS lc_messages",
    );
    if (result.rowCount !== 1) throw new Error('PostgreSQL readiness query returned no row.');
    assertEnglishPostgresMessages(result.rows[0]?.lc_messages);
  }

  #verifyRecovery(): Promise<void> {
    if (this.#recoveryVerification) return this.#recoveryVerification;
    this.#recoveryVerification = (async () => {
      try {
        await this.#verifyConnection();
        this.#recordReady();
      } catch (error) {
        this.#recordUnavailable('readiness-recovery', error);
        throw error;
      } finally {
        this.#recoveryVerification = undefined;
      }
    })();
    return this.#recoveryVerification;
  }
}

export async function createPostgresDatabase(
  options: CreatePostgresDatabaseOptions = {},
): Promise<PostgresDatabase> {
  const environment = options.environment ?? loadDatabaseEnvironment();
  let pool: Pool | undefined;
  let database: PostgresDatabase | undefined;
  try {
    pool = createPostgresClient(poolConfig(environment));
    database = new PostgresDatabase({
      pool,
      close: closePostgresClient,
      ...(options.logger ? {logger: options.logger} : {}),
    });
    await database.initialize();
    return database;
  } catch (error) {
    if (database) {
      await database.close();
    } else if (pool) {
      await closePostgresClient();
    }
    throw error;
  }
}

export function poolConfig(environment: DatabaseEnvironment): PoolConfig {
  return {
    host: environment.POSTGRES_HOST,
    port: environment.POSTGRES_PORT,
    user: environment.POSTGRES_USERNAME,
    password: environment.POSTGRES_PASSWORD,
    database: environment.POSTGRES_DATABASE,
    max: environment.POSTGRES_MAX_CONNECTIONS,
    connectionTimeoutMillis: environment.POSTGRES_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: environment.POSTGRES_IDLE_TIMEOUT_MS,
    keepAlive: true,
    ssl: environment.POSTGRES_TLS_MODE === 'verify-full' ? {rejectUnauthorized: true} : false,
  };
}

type IsolationLevel = 'read committed' | 'repeatable read' | 'serializable';

export function mapPostgresError(
  error: unknown,
  options: {readonly readOnly?: boolean; readonly statementTimeoutMs: number},
): unknown {
  const code = databaseErrorCode(error);
  if (options.readOnly && code === '25006') return new ReadOnlyTransactionError();
  if (code === '57014' && databaseErrorMessageIncludes(error, 'statement timeout')) {
    return new StatementTimeoutError(options.statementTimeoutMs);
  }
  return error;
}

function isConnectionFailure(error: unknown): boolean {
  const code = databaseErrorCode(error);
  return Boolean(
    code?.startsWith('08') ||
      code === '57P01' ||
      code === '57P02' ||
      code === '57P03' ||
      code === 'ECONNREFUSED' ||
      code === 'ECONNRESET' ||
      code === 'ETIMEDOUT' ||
      code === 'ENOTFOUND' ||
      code === 'EHOSTUNREACH' ||
      code === 'EPIPE' ||
      code === 'ECONNABORTED' ||
      databaseErrorMessageIncludes(error, 'connection terminated unexpectedly') ||
      databaseErrorMessageIncludes(error, 'connection terminated due to connection timeout') ||
      databaseErrorMessageIncludes(error, 'timeout exceeded when trying to connect'),
  );
}

function databaseErrorAttributes(error: unknown): Readonly<Record<string, unknown>> {
  const code = databaseErrorCode(error);
  return {
    ...(code ? {code} : {}),
    errorType: error instanceof Error ? error.name : typeof error,
  };
}

function describeDatabaseError(error: unknown): string {
  const code = databaseErrorCode(error);
  const message = error instanceof Error ? error.message : 'Unknown PostgreSQL connection failure.';
  return code ? `PostgreSQL ${code}: ${message}` : `PostgreSQL: ${message}`;
}

/** Returns the first PostgreSQL SQLSTATE found in an error's causal chain. */
export function databaseErrorCode(error: unknown): string | undefined {
  let candidate = error;
  const seen = new Set<object>();
  while (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate);
    if ('code' in candidate && typeof candidate.code === 'string') return candidate.code;
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return undefined;
}

function databaseErrorMessageIncludes(error: unknown, expected: string): boolean {
  let candidate = error;
  const seen = new Set<object>();
  while (candidate && typeof candidate === 'object' && !seen.has(candidate)) {
    seen.add(candidate);
    if (candidate instanceof Error && candidate.message.toLowerCase().includes(expected)) {
      return true;
    }
    candidate = 'cause' in candidate ? candidate.cause : undefined;
  }
  return false;
}

function assertEnglishPostgresMessages(locale: string | undefined): void {
  const normalized = locale?.trim().toLowerCase();
  if (
    normalized === 'c' ||
    normalized === 'posix' ||
    normalized?.startsWith('c.') ||
    normalized?.startsWith('en_') ||
    normalized?.startsWith('en-')
  ) {
    return;
  }
  throw new Error(
    `PostgreSQL lc_messages must use an English locale so query cancellations can be classified; received ${locale ?? 'an empty value'}.`,
  );
}
