import { randomUUID } from 'node:crypto';

import type { Pool } from 'pg';

const safeIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;

export interface AccountDeletionReceipt {
  requestId: string;
  requestedAt: string;
  replayed: boolean;
}

export class PostgresAccountDeletionRequests {
  readonly #schema: string;

  constructor(
    private readonly pool: Pool,
    schema = 'public',
  ) {
    if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
    this.#schema = schema;
  }

  async accept(input: {
    userId: string;
    idempotencyKey: string;
    requestHash: string;
    traceId: string;
  }): Promise<AccountDeletionReceipt | 'key_reused' | 'not_found'> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${this.#schema}", public`);
      await client.query("select set_config('app.user_id', $1, true)", [input.userId]);
      const result = await client.query<{
        result_status: string;
        request_id: string | null;
        requested_at: Date | null;
      }>('select * from accept_account_deletion($1, $2, $3, $4, $5, $6)', [
        input.idempotencyKey,
        input.requestHash,
        randomUUID(),
        randomUUID(),
        randomUUID(),
        input.traceId,
      ]);
      await client.query('commit');
      const row = result.rows[0];
      if (!row || row.result_status === 'not_found') return 'not_found';
      if (row.result_status === 'key_reused') return 'key_reused';
      if (!row.request_id || !row.requested_at) throw new Error('注销受理未返回回执');
      return {
        requestId: row.request_id,
        requestedAt: row.requested_at.toISOString(),
        replayed: row.result_status === 'replayed',
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async recordAuthRevocation(userId: string, requestId: string, errorCode?: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${this.#schema}", public`);
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
      await client.query('select record_account_auth_revocation($1, $2)', [
        requestId,
        errorCode ?? null,
      ]);
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export interface AccountDeletionCleanupReport {
  selectedCount: number;
  purgedCount: number;
  blockedUnexportedCount: number;
  resumesDeleted: number;
  versionsDeleted: number;
  receiptsDeleted: number;
  auditsDeleted: number;
  authSessionsDeleted: number;
  authAccountsDeleted: number;
  authVerificationsDeleted: number;
  authUsersDeleted: number;
  oldestOverdueSeconds: number;
}

export class PostgresAccountDeletionCleaner {
  readonly #schema: string;

  constructor(
    private readonly pool: Pool,
    schema = 'public',
  ) {
    if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
    this.#schema = schema;
  }

  async run(input: { limit: number; dryRun: boolean; runId: string }) {
    const result = await this.pool.query<{
      selected_count: number;
      purged_count: number;
      blocked_unexported_count: number;
      resumes_deleted: number;
      versions_deleted: number;
      receipts_deleted: number;
      audits_deleted: number;
      auth_sessions_deleted: number;
      auth_accounts_deleted: number;
      auth_verifications_deleted: number;
      auth_users_deleted: number;
      oldest_overdue_seconds: string;
    }>(`select * from "${this.#schema}".purge_deleted_accounts($1, $2, $3)`, [
      input.limit,
      input.dryRun,
      input.runId,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('账户清理未返回报告');
    return {
      selectedCount: row.selected_count,
      purgedCount: row.purged_count,
      blockedUnexportedCount: row.blocked_unexported_count,
      resumesDeleted: row.resumes_deleted,
      versionsDeleted: row.versions_deleted,
      receiptsDeleted: row.receipts_deleted,
      auditsDeleted: row.audits_deleted,
      authSessionsDeleted: row.auth_sessions_deleted,
      authAccountsDeleted: row.auth_accounts_deleted,
      authVerificationsDeleted: row.auth_verifications_deleted,
      authUsersDeleted: row.auth_users_deleted,
      oldestOverdueSeconds: Number(row.oldest_overdue_seconds),
    } satisfies AccountDeletionCleanupReport;
  }
}
