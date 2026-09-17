import { parseServerRuntimeConfig } from '@resume/config/server';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { seedFixedResume } from '@resume/infrastructure/resume-seed';

const config = parseServerRuntimeConfig(process.env);
if (
  config.APP_ENV !== 'local' ||
  config.AUTH_MODE !== 'fixed' ||
  !config.DEV_FIXED_USER_ID ||
  !config.DEV_FIXED_RESUME_ID ||
  !config.DEV_FIXED_VERSION_ID
) {
  throw new Error('开发 Seed 只允许 local + fixed，且必须配置全部固定 ID');
}

const pool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-development-seed',
});

try {
  const result = await seedFixedResume(pool, {
    userId: config.DEV_FIXED_USER_ID,
    resumeId: config.DEV_FIXED_RESUME_ID,
    versionId: config.DEV_FIXED_VERSION_ID,
  });
  console.log(JSON.stringify(result));
} finally {
  await pool.end();
}
