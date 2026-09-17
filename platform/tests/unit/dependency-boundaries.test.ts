import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const workspaceRoot = resolve(import.meta.dirname, '../..');
const fixtureRoot = resolve(workspaceRoot, 'tests/fixtures/boundaries');
const dependencyCruiserCli = resolve(
  workspaceRoot,
  'node_modules/dependency-cruiser/bin/dependency-cruise.mjs',
);

function cruiseFixture(name: string) {
  return spawnSync(
    process.execPath,
    [
      dependencyCruiserCli,
      '--config',
      resolve(workspaceRoot, '.dependency-cruiser.cjs'),
      resolve(fixtureRoot, name),
      '--output-type',
      'err',
    ],
    { cwd: workspaceRoot, encoding: 'utf8' },
  );
}

describe('dependency boundary checker', () => {
  it('accepts a valid dependency graph', () => {
    const result = cruiseFixture('positive');

    expect(result.status, result.stderr || result.stdout).toBe(0);
  });

  it.each([
    ['domain-to-infrastructure', 'domain-is-pure'],
    ['client-to-infrastructure', 'client-no-server'],
    ['client-to-server-config', 'client-no-server'],
    ['package-to-app', 'packages-no-apps'],
    ['private-package-import', 'no-private-package-imports'],
    ['circular', 'no-circular'],
  ])('rejects %s through %s', (fixture, rule) => {
    const result = cruiseFixture(fixture);
    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).not.toBe(0);
    expect(output).toContain(rule);
  });
});
