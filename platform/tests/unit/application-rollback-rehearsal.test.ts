import { describe, expect, it } from 'vitest';

import { assertApplicationRollbackEnvironment } from '../../scripts/ops/rehearse-application-rollback';

describe('application rollback rehearsal safety', () => {
  const migrationUrl = 'postgresql://resume_opt_migrator:secret@127.0.0.1/resume_opt_dev';
  const applicationUrl = 'postgresql://resume_opt_app:secret@127.0.0.1/resume_opt_dev';

  it('accepts only an isolated local/test rehearsal with split roles', () => {
    expect(() => {
      assertApplicationRollbackEnvironment('test', migrationUrl, applicationUrl);
    }).not.toThrow();
    expect(() => {
      assertApplicationRollbackEnvironment('production', migrationUrl, applicationUrl);
    }).toThrow('禁止 production');
    expect(() => {
      assertApplicationRollbackEnvironment(
        'test',
        migrationUrl,
        'postgresql://resume_opt_migrator:secret@127.0.0.1/resume_opt_dev',
      );
    }).toThrow('角色');
    expect(() => {
      assertApplicationRollbackEnvironment(
        'test',
        migrationUrl,
        'postgresql://resume_opt_app:secret@127.0.0.1/resume_opt_test',
      );
    }).toThrow('同一数据库');
  });
});
