import { createHash } from 'node:crypto';

import { createInitialResumeDocument } from '@resume/domain/resume';
import type { Pool } from 'pg';

export interface FixedResumeSeed {
  userId: string;
  resumeId: string;
  versionId: string;
  schema?: string;
}

export interface FixedResumeSeedResult {
  created: boolean;
  revision: string;
}

const safeIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;

function createDocumentIdFactory() {
  let counter = 1;
  return () => `30000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

export async function seedFixedResume(
  pool: Pool,
  seed: FixedResumeSeed,
): Promise<FixedResumeSeedResult> {
  const schema = seed.schema ?? 'public';
  if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
  const document = createInitialResumeDocument(createDocumentIdFactory());
  const contentHash = createHash('sha256').update(JSON.stringify(document)).digest('hex');
  const client = await pool.connect();

  try {
    await client.query('begin');
    await client.query(`set local search_path to "${schema}", public`);
    await client.query(
      `insert into templates
        (template_id, version, renderer_version, manifest, asset_hash, status)
       values ('ats-basic', '1.0.0', '1.0.0', $1::jsonb, $2, 'published')
       on conflict (template_id, version) do nothing`,
      [
        JSON.stringify({
          locale: 'zh-CN',
          pageFormat: 'A4',
          rendererVersion: '1.0.0',
          fontFamilyId: 'noto-sans-sc',
        }),
        'v0.1-fixture',
      ],
    );
    await client.query(
      `insert into users(id, status, display_name)
       values ($1, 'active', 'V0.1 测试用户')
       on conflict (id) do nothing`,
      [seed.userId],
    );
    const inserted = await client.query<{ revision: string }>(
      `insert into resumes
        (id, user_id, title, document, revision, schema_version, template_id, template_version)
       values ($1, $2, '前端开发工程师简历', $3::jsonb, 1, 1, 'ats-basic', '1.0.0')
       on conflict (id) do nothing
       returning revision`,
      [seed.resumeId, seed.userId, JSON.stringify(document)],
    );

    if (inserted.rows[0]) {
      await client.query(
        `insert into resume_versions
          (id, resume_id, user_id, revision, title_snapshot, schema_version,
           template_id, template_version, renderer_version, snapshot, content_hash, reason)
         values ($1, $2, $3, 1, '前端开发工程师简历', 1,
                 'ats-basic', '1.0.0', '1.0.0', $4::jsonb, $5, 'initial')`,
        [seed.versionId, seed.resumeId, seed.userId, JSON.stringify(document), contentHash],
      );
      await client.query('commit');
      return { created: true, revision: inserted.rows[0].revision };
    }

    const existing = await client.query<{
      user_id: string;
      revision: string;
      schema_version: number;
      template_id: string;
      template_version: string;
      has_initial_version: boolean;
    }>(
      `select r.user_id, r.revision, r.schema_version, r.template_id, r.template_version,
              exists(
                select 1 from resume_versions v
                 where v.resume_id = r.id and v.revision = 1
              ) as has_initial_version
         from resumes r where r.id = $1`,
      [seed.resumeId],
    );
    const row = existing.rows[0];
    if (
      !row ||
      row.user_id !== seed.userId ||
      row.schema_version !== 1 ||
      row.template_id !== 'ats-basic' ||
      row.template_version !== '1.0.0' ||
      !row.has_initial_version
    ) {
      throw new Error('固定测试简历已存在但不符合 Seed 不变量');
    }
    await client.query('commit');
    return { created: false, revision: row.revision };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}
