import assert from 'node:assert/strict';
import test from 'node:test';
import { Client } from 'pg';

const required = (name: 'PG_DEV_URL' | 'PG_MIGRATION_URL' | 'PG_TEST_URL'): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
};
const queryIdentity = async (connectionString: string) => {
  const client = new Client({ connectionString, connectionTimeoutMillis: 5_000 });
  await client.connect();
  try { return (await client.query<{ user_name: string; database_name: string }>('SELECT current_user AS user_name,current_database() AS database_name')).rows[0]!; }
  finally { await client.end(); }
};

test('application, migration and test credentials target their assigned databases', async () => {
  assert.deepEqual(await queryIdentity(required('PG_DEV_URL')),
    { user_name: 'resume_opt_app', database_name: 'resume_opt_dev' });
  assert.deepEqual(await queryIdentity(required('PG_MIGRATION_URL')),
    { user_name: 'resume_opt_migrator', database_name: 'resume_opt_dev' });
  assert.deepEqual(await queryIdentity(required('PG_TEST_URL')),
    { user_name: 'resume_opt_test', database_name: 'resume_opt_test' });
});

test('the application role cannot create schema objects', async () => {
  const client = new Client({ connectionString: required('PG_DEV_URL'), connectionTimeoutMillis: 5_000 });
  await client.connect();
  try {
    await assert.rejects(() => client.query('CREATE TABLE public.permission_probe(id integer)'), /permission denied/i);
  } finally { await client.end(); }
});

test('the test role cannot connect to the development database', async () => {
  const target = new URL(required('PG_TEST_URL'));
  target.pathname = '/resume_opt_dev';
  const client = new Client({ connectionString: target.toString(), connectionTimeoutMillis: 5_000 });
  await assert.rejects(() => client.connect(), /permission denied for database/i);
  await client.end().catch(() => undefined);
});
