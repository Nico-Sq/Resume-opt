import { describe, expect, it } from 'vitest';

import { parseCleanupOptions } from '../../scripts/ops/purge-expired-resumes';

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
