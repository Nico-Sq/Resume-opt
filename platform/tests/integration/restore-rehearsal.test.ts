import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { rehearseLogicalRestore } from '../../scripts/ops/rehearse-logical-restore';

const testDatabase = parseDatabaseToolConfig({ ...process.env, APP_ENV: 'test' }, 'test');

describe('synthetic logical restore rehearsal', () => {
  it('restores every V0.1 table into an isolated migrated schema and verifies invariants', async () => {
    const report = await rehearseLogicalRestore({
      connectionString: testDatabase.connectionString,
      environment: 'test',
      migrationsDirectory: resolve(import.meta.dirname, '../../database/migrations'),
    });

    expect(report.passed).toBe(true);
    expect(report.checks).toEqual({
      sourceMigrated: true,
      targetMigrated: true,
      rowCountsMatch: true,
      hashesMatch: true,
      expectedRlsPolicies: true,
      uniqueConstraintEnforced: true,
    });
    expect(report.actualRpoSeconds).toBeNull();
    expect(report.limitations).toContain('不得据此宣称生产 RPO/RTO 达标');
  });
});
