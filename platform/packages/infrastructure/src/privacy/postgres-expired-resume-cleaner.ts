import type { Pool } from 'pg';

const safeIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;

export interface ExpiredResumeCleanupReport {
  selectedCount: number;
  purgedCount: number;
  blockedUnexportedCount: number;
  versionsDeleted: number;
  receiptsDeleted: number;
  auditsDeleted: number;
  oldestOverdueSeconds: number;
}

export class PostgresExpiredResumeCleaner {
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
      versions_deleted: number;
      receipts_deleted: number;
      audits_deleted: number;
      oldest_overdue_seconds: string;
    }>(`select * from "${this.#schema}".purge_expired_resumes($1, $2, $3)`, [
      input.limit,
      input.dryRun,
      input.runId,
    ]);
    const row = result.rows[0];
    if (!row) throw new Error('隐私清理未返回报告');
    return {
      selectedCount: row.selected_count,
      purgedCount: row.purged_count,
      blockedUnexportedCount: row.blocked_unexported_count,
      versionsDeleted: row.versions_deleted,
      receiptsDeleted: row.receipts_deleted,
      auditsDeleted: row.audits_deleted,
      oldestOverdueSeconds: Number(row.oldest_overdue_seconds),
    } satisfies ExpiredResumeCleanupReport;
  }
}
