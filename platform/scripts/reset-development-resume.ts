import { createHash, randomUUID } from 'node:crypto';

import { parseServerRuntimeConfig } from '@resume/config/server';
import { createPostgresPool } from '@resume/infrastructure/postgres';
import { createPrototypeDocument } from '@resume/infrastructure/resume-seed';

const config = parseServerRuntimeConfig(process.env);
if (
  config.APP_ENV !== 'local' ||
  config.AUTH_MODE !== 'fixed' ||
  !config.DEV_FIXED_USER_ID ||
  !config.DEV_FIXED_RESUME_ID
) {
  throw new Error('原型数据重置只允许 local + fixed，且必须配置固定用户和简历 ID');
}

const document = createPrototypeDocument();
const snapshot = JSON.stringify(document);
const contentHash = createHash('sha256').update(snapshot).digest('hex');
const pool = createPostgresPool({
  connectionString: config.PG_MIGRATION_URL,
  max: 1,
  applicationName: 'resume-opt-prototype-reset',
});
const client = await pool.connect();

try {
  await client.query('begin');
  const current = await client.query<{ revision: string }>(
    `select revision::text from resumes
      where id = $1 and user_id = $2 and deleted_at is null
      for update`,
    [config.DEV_FIXED_RESUME_ID, config.DEV_FIXED_USER_ID],
  );
  const row = current.rows[0];
  if (!row) throw new Error('固定测试简历不存在，无法执行原型数据重置');
  const revision = String(Number(row.revision) + 1);
  await client.query(
    `update resumes
        set title = '张三的简历', document = $1::jsonb, revision = $2::bigint,
            updated_at = clock_timestamp()
      where id = $3 and user_id = $4`,
    [snapshot, revision, config.DEV_FIXED_RESUME_ID, config.DEV_FIXED_USER_ID],
  );
  await client.query(
    `insert into resume_versions
      (id, resume_id, user_id, revision, title_snapshot, schema_version,
       template_id, template_version, renderer_version, snapshot, content_hash, reason)
     values ($1, $2, $3, $4::bigint, '张三的简历', 1,
             'ats-basic', '1.0.0', '1.0.0', $5::jsonb, $6, 'restore')`,
    [
      randomUUID(),
      config.DEV_FIXED_RESUME_ID,
      config.DEV_FIXED_USER_ID,
      revision,
      snapshot,
      contentHash,
    ],
  );
  await client.query('commit');
  console.log(JSON.stringify({ resumeId: config.DEV_FIXED_RESUME_ID, revision }));
} catch (error) {
  await client.query('rollback');
  throw error;
} finally {
  client.release();
  await pool.end();
}
