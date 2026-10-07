import { describe, expect, it } from 'vitest';

import { assertManifestExportEnvironment } from '../../scripts/ops/export-deletion-manifest';
import { parseCleanupOptions } from '../../scripts/ops/purge-expired-resumes';
import { parseAccountCleanupOptions } from '../../scripts/ops/purge-deleted-accounts';

describe('expired resume cleanup CLI safety', () => {
  it('accepts an explicit bounded test dry run', () => {
    expect(parseCleanupOptions(['--environment=test', '--limit=25', '--dry-run'])).toEqual({
      environment: 'test',
      limit: 25,
      dryRun: true,
    });
  });

  it.each([
    { arguments_: [] },
    { arguments_: ['--environment=local'] },
    { arguments_: ['--environment=production'] },
  ])('rejects a non-test target: $arguments_', ({ arguments_ }) => {
    expect(() => parseCleanupOptions(arguments_)).toThrow('只允许 --environment=test');
  });

  it.each(['0', '101', '1.5', 'unknown'])('rejects unsafe batch limit %s', (limit) => {
    expect(() => parseCleanupOptions(['--environment=test', `--limit=${limit}`])).toThrow(
      '1 到 100',
    );
  });
});

describe('deletion manifest export CLI safety', () => {
  it('only accepts the synthetic test database environment', () => {
    expect(() => {
      assertManifestExportEnvironment('test');
    }).not.toThrow();
    expect(() => {
      assertManifestExportEnvironment('local');
    }).toThrow('只允许 test 环境');
    expect(() => {
      assertManifestExportEnvironment('production');
    }).toThrow('只允许 test 环境');
  });
});

describe('account deletion cleanup CLI safety', () => {
  it('accepts only an explicit bounded test run', () => {
    expect(parseAccountCleanupOptions(['--environment=test', '--limit=25', '--dry-run'])).toEqual({
      environment: 'test',
      limit: 25,
      dryRun: true,
    });
    expect(() => parseAccountCleanupOptions(['--environment=production'])).toThrow(
      '只允许 --environment=test',
    );
    expect(() => parseAccountCleanupOptions(['--environment=test', '--limit=101'])).toThrow(
      '1 到 100',
    );
  });
});
