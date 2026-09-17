import { Pool } from 'pg';

export interface DatabasePoolOptions {
  connectionString: string;
  max: number;
  applicationName: string;
}

export function createPostgresPool(options: DatabasePoolOptions): Pool {
  return new Pool({
    connectionString: options.connectionString,
    max: options.max,
    application_name: options.applicationName,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    query_timeout: 12_000,
  });
}

export async function checkDatabaseReadiness(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ ready: number }>('select 1 as ready');
    return result.rows[0]?.ready === 1;
  } catch {
    return false;
  }
}
