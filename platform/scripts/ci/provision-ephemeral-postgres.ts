import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createPostgresPool } from '@resume/infrastructure/postgres';

const ciRoles = ['resume_opt_app', 'resume_opt_migrator', 'resume_opt_test'] as const;
const ciDatabases = ['resume_opt_dev', 'resume_opt_test'] as const;

export function assertEphemeralAdminTarget(ci: string | undefined, connectionString: string): void {
  if (ci !== 'true') throw new Error('临时数据库初始化只允许在 CI=true 时运行');

  const url = new URL(connectionString);
  const hostIsLocal = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  const port = url.port || '5432';
  const database = url.pathname.slice(1);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !hostIsLocal ||
    port !== '5432' ||
    url.username !== 'postgres' ||
    database !== 'postgres'
  ) {
    throw new Error('临时数据库初始化只允许连接 localhost:5432 的 postgres 管理库和 postgres 用户');
  }
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少环境变量 ${name}`);
  return value;
}

async function configureDatabase(
  connectionString: string,
  database: 'resume_opt_dev' | 'resume_opt_test',
): Promise<void> {
  const pool = createPostgresPool({
    connectionString,
    max: 1,
    applicationName: `resume-opt-ci-provision-${database}`,
  });
  try {
    const identity = await pool.query<{ database: string; user: string }>(
      'select current_database() as database, current_user as user',
    );
    if (identity.rows[0]?.database !== database) {
      throw new Error(`数据库连接目标错误：期望 ${database}`);
    }
    await pool.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
    if (database === 'resume_opt_dev') {
      if (identity.rows[0].user !== 'resume_opt_migrator') {
        throw new Error('开发库必须由 resume_opt_migrator 配置');
      }
      await pool.query('GRANT USAGE ON SCHEMA public TO resume_opt_app');
      await pool.query(
        'ALTER DEFAULT PRIVILEGES FOR ROLE resume_opt_migrator IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO resume_opt_app',
      );
      await pool.query(
        'ALTER DEFAULT PRIVILEGES FOR ROLE resume_opt_migrator IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO resume_opt_app',
      );
    }
  } finally {
    await pool.end();
  }
}

export function createProvisioningEvidence(serverVersion: string, generatedAt: string) {
  return {
    schemaVersion: 1,
    scope: 'github-hosted-ephemeral-postgresql',
    generatedAt,
    serverVersion,
    roles: [...ciRoles],
    databases: [...ciDatabases],
    safety: {
      ciRequired: true,
      localhostOnly: true,
      existingObjectsRejected: true,
      productionCredentialsUsed: false,
    },
    passed: true,
  };
}

export async function provisionEphemeralPostgres(): Promise<{ serverVersion: string }> {
  const adminUrl = requiredEnvironment('PG_ADMIN_URL');
  assertEphemeralAdminTarget(process.env.CI, adminUrl);
  const admin = createPostgresPool({
    connectionString: adminUrl,
    max: 1,
    applicationName: 'resume-opt-ci-provision-admin',
  });
  let serverVersion = '';

  try {
    const version = await admin.query<{ server_version: string }>('show server_version');
    serverVersion = version.rows[0]?.server_version ?? '';
    if (!serverVersion) throw new Error('无法读取 PostgreSQL server_version');
    const existingRoles = await admin.query<{ rolname: string }>(
      'SELECT rolname FROM pg_roles WHERE rolname = ANY($1)',
      [ciRoles],
    );
    const existingDatabases = await admin.query<{ datname: string }>(
      'SELECT datname FROM pg_database WHERE datname = ANY($1)',
      [ciDatabases],
    );
    if (existingRoles.rowCount || existingDatabases.rowCount) {
      throw new Error(
        `Runner 不是全新数据库实例；拒绝覆盖已有角色或数据库。角色：${
          existingRoles.rows.map((row) => row.rolname).join(', ') || '无'
        }；数据库：${existingDatabases.rows.map((row) => row.datname).join(', ') || '无'}`,
      );
    }

    await admin.query(
      "CREATE ROLE resume_opt_app LOGIN PASSWORD 'ci-app-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
    await admin.query(
      "CREATE ROLE resume_opt_migrator LOGIN PASSWORD 'ci-migrator-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
    await admin.query(
      "CREATE ROLE resume_opt_test LOGIN PASSWORD 'ci-test-password' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION",
    );
    await admin.query(
      "CREATE DATABASE resume_opt_dev OWNER resume_opt_migrator ENCODING 'UTF8' TEMPLATE template0",
    );
    await admin.query(
      "CREATE DATABASE resume_opt_test OWNER resume_opt_test ENCODING 'UTF8' TEMPLATE template0",
    );
    await admin.query('REVOKE CONNECT ON DATABASE resume_opt_dev FROM PUBLIC');
    await admin.query('REVOKE CONNECT ON DATABASE resume_opt_test FROM PUBLIC');
    await admin.query(
      'GRANT CONNECT ON DATABASE resume_opt_dev TO resume_opt_app, resume_opt_migrator',
    );
    await admin.query('GRANT CONNECT ON DATABASE resume_opt_test TO resume_opt_test');
  } catch (error) {
    throw new Error(
      `CI 临时数据库初始化中止，实例可能已部分创建；Runner 应直接销毁，不得在该实例重试。原因：${String(error)}`,
    );
  } finally {
    await admin.end();
  }

  await configureDatabase(requiredEnvironment('PG_MIGRATION_URL'), 'resume_opt_dev');
  await configureDatabase(requiredEnvironment('PG_TEST_URL'), 'resume_opt_test');
  console.log(
    'CI ephemeral PostgreSQL roles and databases are ready. No credentials were printed.',
  );
  return { serverVersion };
}

async function main(): Promise<void> {
  const { serverVersion } = await provisionEphemeralPostgres();
  const evidenceDirectory = resolve('artifacts/ci');
  const evidencePath = resolve(evidenceDirectory, 'provisioning.json');
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    evidencePath,
    `${JSON.stringify(createProvisioningEvidence(serverVersion, new Date().toISOString()), null, 2)}\n`,
    'utf8',
  );
  console.log(`Sanitized provisioning evidence written to ${evidencePath}.`);
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath === fileURLToPath(import.meta.url)) await main();
