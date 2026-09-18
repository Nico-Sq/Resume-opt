import { describe, expect, it } from 'vitest';

import { assertEphemeralAdminTarget } from '../../scripts/ci/provision-ephemeral-postgres';

describe('CI ephemeral PostgreSQL safety gate', () => {
  const localAdminUrl = 'postgresql://postgres:ephemeral@127.0.0.1:5432/postgres';

  it('accepts only an explicit CI run against the local postgres administration database', () => {
    expect(() => {
      assertEphemeralAdminTarget('true', localAdminUrl);
    }).not.toThrow();
    expect(() => {
      assertEphemeralAdminTarget(undefined, localAdminUrl);
    }).toThrow('CI=true');
    expect(() => {
      assertEphemeralAdminTarget('false', localAdminUrl);
    }).toThrow('CI=true');
  });

  it.each([
    'postgresql://postgres:secret@192.168.19.200:5432/postgres',
    'postgresql://postgres:secret@127.0.0.1:5433/postgres',
    'postgresql://admin:secret@127.0.0.1:5432/postgres',
    'postgresql://postgres:secret@127.0.0.1:5432/resume_opt_dev',
    'https://postgres:secret@127.0.0.1:5432/postgres',
  ])('rejects unsafe administration target %s', (connectionString) => {
    expect(() => {
      assertEphemeralAdminTarget('true', connectionString);
    }).toThrow('只允许连接 localhost:5432');
  });
});
