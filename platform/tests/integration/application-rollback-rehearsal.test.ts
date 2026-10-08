import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { rehearseApplicationRollback } from '../../scripts/ops/rehearse-application-rollback';

describe('V0.1 compatible application rollback rehearsal', () => {
  it('upgrades a populated V0.1 fixture and preserves read, write, CAS and role isolation', async () => {
    const migrationUrl = process.env.PG_MIGRATION_URL;
    const applicationUrl = process.env.PG_DEV_URL;
    if (!migrationUrl || !applicationUrl) throw new Error('兼容回滚演练缺少本地数据库配置');

    const report = await rehearseApplicationRollback({
      environment: 'test',
      migrationUrl,
      applicationUrl,
      migrationsDirectory: resolve(import.meta.dirname, '../../database/migrations'),
    });

    expect(report.passed).toBe(true);
    expect(report.schemaVersions).toEqual({ before: ['0001_initial.up.sql'], afterCount: 9 });
    expect(report.checks).toEqual({
      legacyOwnerHashAndRevisionPreserved: true,
      currentApplicationWriteSucceeded: true,
      compatibleRollbackReadSucceeded: true,
      compatibleRollbackWriteSucceeded: true,
      staleCasRejected: true,
      runtimeRolesRemainRestricted: true,
      destructiveDownNotExecuted: true,
    });
  });
});
