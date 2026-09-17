import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

const safeIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;

function quoteIdentifier(identifier: string) {
  if (!safeIdentifier.test(identifier)) throw new Error(`不安全的数据库标识符：${identifier}`);
  return `"${identifier}"`;
}

export async function runMigrations(
  pool: Pool,
  migrationsDirectory: string,
  schema = 'public',
): Promise<MigrationResult> {
  const files = (await readdir(migrationsDirectory))
    .filter((file) => /^\d+_[a-z0-9_]+\.up\.sql$/u.test(file))
    .sort();
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };

  try {
    await client.query('begin');
    await client.query(`set local search_path to ${quoteIdentifier(schema)}, public`);
    await client.query(
      "select pg_advisory_xact_lock(hashtext('resume_opt_migrations:' || current_schema()))",
    );
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )
    `);

    for (const file of files) {
      const sql = await readFile(join(migrationsDirectory, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = await client.query<{ checksum: string }>(
        'select checksum from schema_migrations where name = $1',
        [file],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== checksum) {
          throw new Error(`已执行迁移的校验和发生变化：${file}`);
        }
        result.alreadyApplied.push(file);
        continue;
      }

      await client.query(sql);
      await client.query('insert into schema_migrations(name, checksum) values ($1, $2)', [
        file,
        checksum,
      ]);
      result.applied.push(file);
    }
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
