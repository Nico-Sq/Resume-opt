import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

const host = '192.168.19.200';
const port = 5432;
const adminUser = 'postgres';
const adminDatabase = 'postgres';
const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = resolve(platformRoot, '.env.local');
const password = (length = 32) => randomBytes(length).toString('base64url');

async function hidden(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) throw new Error('A TTY is required for hidden password input.');
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  return await new Promise((resolvePassword, reject) => {
    let value = '';
    const onData = (key: string) => {
      if (key === '\u0003') { cleanup(); reject(new Error('Cancelled.')); return; }
      if (key === '\r' || key === '\n') { cleanup(); process.stdout.write('\n'); resolvePassword(value); return; }
      if (key === '\u007f' || key === '\b') { value = value.slice(0, -1); return; }
      if (/^[\x20-\x7E]+$/.test(key)) value += key;
    };
    const cleanup = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };
    process.stdin.on('data', onData);
  });
}

const adminPassword = await hidden('PostgreSQL admin password (hidden): ');
const admin = new Client({ host, port, user: adminUser, password: adminPassword, database: adminDatabase,
  connectionTimeoutMillis: 5_000 });
await admin.connect();

const roles = ['resume_opt_app', 'resume_opt_migrator', 'resume_opt_test'] as const;
const databases = ['resume_opt_dev', 'resume_opt_test'] as const;
const existingRoles = await admin.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1)', [roles]);
const existingDatabases = await admin.query<{ datname: string }>('SELECT datname FROM pg_database WHERE datname = ANY($1)', [databases]);
if (existingRoles.rowCount || existingDatabases.rowCount) {
  await admin.end();
  throw new Error(`Refusing to overwrite existing objects. Roles: ${existingRoles.rows.map(r => r.rolname).join(', ') || 'none'}; databases: ${existingDatabases.rows.map(r => r.datname).join(', ') || 'none'}.`);
}

const secrets = { app: password(), migrator: password(), test: password() };
try {
  await admin.query(`CREATE ROLE resume_opt_app LOGIN PASSWORD '${secrets.app}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query(`CREATE ROLE resume_opt_migrator LOGIN PASSWORD '${secrets.migrator}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query(`CREATE ROLE resume_opt_test LOGIN PASSWORD '${secrets.test}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION`);
  await admin.query('CREATE DATABASE resume_opt_dev OWNER resume_opt_migrator ENCODING \'UTF8\' TEMPLATE template0');
  await admin.query('CREATE DATABASE resume_opt_test OWNER resume_opt_test ENCODING \'UTF8\' TEMPLATE template0');
  await admin.query('REVOKE CONNECT ON DATABASE resume_opt_dev FROM PUBLIC');
  await admin.query('REVOKE CONNECT ON DATABASE resume_opt_test FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE resume_opt_dev TO resume_opt_app, resume_opt_migrator');
  await admin.query('GRANT CONNECT ON DATABASE resume_opt_test TO resume_opt_test');
} catch (error) {
  // Objects already created are intentionally not dropped automatically.
  throw new Error(`Database provisioning stopped and may be partial. Inspect with DBeaver before retrying. Cause: ${String(error)}`);
} finally {
  await admin.end();
}

for (const [database, user, rolePassword] of [
  ['resume_opt_dev', 'resume_opt_migrator', secrets.migrator],
  ['resume_opt_test', 'resume_opt_test', secrets.test],
] as const) {
  const client = new Client({ host, port, database, user, password: rolePassword, connectionTimeoutMillis: 5_000 });
  await client.connect();
  await client.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  if (database === 'resume_opt_dev') {
    await client.query('GRANT USAGE ON SCHEMA public TO resume_opt_app');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE resume_opt_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO resume_opt_app');
    await client.query('ALTER DEFAULT PRIVILEGES FOR ROLE resume_opt_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO resume_opt_app');
  }
  await client.end();
}

const encode = (value: string) => encodeURIComponent(value);
const url = (user: string, rolePassword: string, database: string) =>
  `postgresql://${user}:${encode(rolePassword)}@${host}:${port}/${database}`;
const content = [
  '# Generated locally. Never commit or share this file.',
  `PG_DEV_URL=${url('resume_opt_app', secrets.app, 'resume_opt_dev')}`,
  `PG_MIGRATION_URL=${url('resume_opt_migrator', secrets.migrator, 'resume_opt_dev')}`,
  `PG_TEST_URL=${url('resume_opt_test', secrets.test, 'resume_opt_test')}`,
  '',
].join('\n');
mkdirSync(dirname(envPath), { recursive: true });
writeFileSync(envPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
console.log('Created isolated databases/roles and platform/.env.local. No secrets were printed.');
