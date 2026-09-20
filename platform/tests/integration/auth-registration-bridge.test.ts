import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseServerRuntimeConfig } from '@resume/config/server';
import { createPostgresPool } from '@resume/infrastructure/postgres';

const config = parseServerRuntimeConfig({
  ...process.env,
  APP_ENV: 'test',
  AUTH_MODE: 'better-auth',
});
const schema = `auth_bridge_${randomUUID().replaceAll('-', '')}`;
const pool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-auth-bridge-contract-test',
});
let schemaCreated = false;

beforeAll(async () => {
  await pool.query(`
    create schema "${schema}";
    create table "${schema}".users (
      id uuid primary key,
      status text not null check (status in ('active', 'disabled')),
      display_name text not null check (char_length(display_name) between 1 and 100)
    );
    create table "${schema}".auth_users (
      id uuid primary key references "${schema}".users(id),
      name text not null,
      email text not null check (email like '%@%')
    );
    create function "${schema}".bridge_auth_user() returns trigger
    language plpgsql
    set search_path = pg_catalog
    as $$
    begin
      insert into "${schema}".users(id, status, display_name)
      values (new.id, 'active', new.name);
      return new;
    end
    $$;
    create trigger auth_users_bridge
      before insert on "${schema}".auth_users
      for each row execute function "${schema}".bridge_auth_user();
  `);
  schemaCreated = true;
});

afterAll(async () => {
  if (schemaCreated && /^auth_bridge_[a-f0-9]{32}$/u.test(schema)) {
    await pool.query(`drop schema "${schema}" cascade`);
  }
  await pool.end();
});

describe('Better Auth registration bridge contract', () => {
  it('creates the business user with the exact auth UUID in the same transaction', async () => {
    const userId = randomUUID();
    await pool.query(`insert into "${schema}".auth_users(id, name, email) values ($1, $2, $3)`, [
      userId,
      '共享身份用户',
      'shared@example.cn',
    ]);

    const result = await pool.query<{ id: string; display_name: string; status: string }>(
      `select id, display_name, status from "${schema}".users where id = $1`,
      [userId],
    );
    expect(result.rows).toEqual([{ id: userId, display_name: '共享身份用户', status: 'active' }]);
  });

  it('rolls back the bridged business row when the auth insert fails', async () => {
    const userId = randomUUID();
    await expect(
      pool.query(`insert into "${schema}".auth_users(id, name, email) values ($1, $2, $3)`, [
        userId,
        '应回滚用户',
        'invalid-email',
      ]),
    ).rejects.toThrow();

    const result = await pool.query(`select id from "${schema}".users where id = $1`, [userId]);
    expect(result.rowCount).toBe(0);
  });
});
