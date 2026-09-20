import { randomBytes } from 'node:crypto';

import { betterAuth } from 'better-auth';
import { PostgresDialect } from 'kysely';
import { Pool } from 'pg';

import { createBetterAuthOptions } from './src/identity/better-auth-contract';

const dialect = new PostgresDialect({
  pool: new Pool({ connectionString: 'postgresql://schema-only@localhost/schema-only' }),
});

export const auth = betterAuth({
  ...createBetterAuthOptions(dialect),
  baseURL: 'http://localhost:3000',
  secret: randomBytes(32).toString('base64url'),
});
