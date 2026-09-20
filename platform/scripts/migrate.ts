import { resolve } from 'node:path';

import { parseDatabaseToolConfig } from '@resume/config/server';
import { runMigrations } from '@resume/infrastructure/migrations';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const databaseFlag = process.argv.find((argument) => argument.startsWith('--database='));
const database = databaseFlag?.split('=')[1];
if (database !== 'dev' && database !== 'test') {
  throw new Error('必须显式指定 --database=dev 或 --database=test');
}

const pool = createPostgresPool({
  connectionString: parseDatabaseToolConfig(process.env, database === 'dev' ? 'migration' : 'test')
    .connectionString,
  max: 1,
  applicationName: `resume-opt-migrate-${database}`,
});

try {
  const result = await runMigrations(pool, resolve(import.meta.dirname, '../database/migrations'));
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
