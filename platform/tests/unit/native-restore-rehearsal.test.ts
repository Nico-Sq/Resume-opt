import { describe, expect, it } from 'vitest';

import {
  assertNativeRestoreEnvironment,
  buildNativeToolCommand,
} from '../../scripts/ops/rehearse-native-restore';

describe('native pg_dump/pg_restore rehearsal safety', () => {
  const testUrl = 'postgresql://resume_opt_test:secret@127.0.0.1:5432/resume_opt_test';
  const containerId = 'a'.repeat(64);

  it('accepts test-only local and validated Docker execution', () => {
    expect(() => {
      assertNativeRestoreEnvironment({
        environment: 'test',
        connectionString: testUrl,
        mode: 'local',
      });
    }).not.toThrow();
    expect(() => {
      assertNativeRestoreEnvironment({
        environment: 'test',
        connectionString: testUrl,
        mode: 'docker',
        containerId,
      });
    }).not.toThrow();
  });

  it('rejects production, other databases and unsafe container IDs', () => {
    expect(() => {
      assertNativeRestoreEnvironment({
        environment: 'production',
        connectionString: testUrl,
        mode: 'local',
      });
    }).toThrow('禁止 production');
    expect(() => {
      assertNativeRestoreEnvironment({
        environment: 'test',
        connectionString: 'postgresql://resume_opt_test:secret@127.0.0.1:5432/resume_opt_dev',
        mode: 'local',
      });
    }).toThrow('只允许连接 resume_opt_test');
    expect(() => {
      assertNativeRestoreEnvironment({
        environment: 'test',
        connectionString: testUrl,
        mode: 'docker',
        containerId: 'postgres; rm -rf /',
      });
    }).toThrow('十六进制容器 ID');
  });

  it('builds argument-array commands without a shell or connection password', () => {
    const command = buildNativeToolCommand({
      mode: 'docker',
      containerId,
      tool: 'pg_dump',
      args: ['--format=custom', '--dbname=resume_opt_test'],
    });

    expect(command).toEqual({
      command: 'docker',
      args: ['exec', containerId, 'pg_dump', '--format=custom', '--dbname=resume_opt_test'],
    });
    expect(JSON.stringify(command)).not.toContain('secret');
  });
});
