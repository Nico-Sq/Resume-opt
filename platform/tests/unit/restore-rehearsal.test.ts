import { describe, expect, it } from 'vitest';

import { assertRestoreEnvironment } from '../../scripts/ops/rehearse-logical-restore';

describe('restore rehearsal safety gate', () => {
  const testUrl = 'postgresql://test:secret@127.0.0.1:5432/resume_opt_test';

  it('only accepts the explicit test environment and test database', () => {
    expect(() => {
      assertRestoreEnvironment('test', testUrl);
    }).not.toThrow();
    expect(() => {
      assertRestoreEnvironment('production', testUrl);
    }).toThrow('只允许连接 resume_opt_test');
    expect(() => {
      assertRestoreEnvironment('test', 'postgresql://test:secret@127.0.0.1:5432/resume_opt_dev');
    }).toThrow('只允许连接 resume_opt_test');
    expect(() => {
      assertRestoreEnvironment('staging', testUrl);
    }).toThrow('environment 必须为 test');
  });
});
