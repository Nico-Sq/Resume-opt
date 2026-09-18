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

export function createPrototypeDocument() {
  const nextId = createDocumentIdFactory();
  const document = createInitialResumeDocument(nextId);
  const sections = Object.values(document.sectionsById);
  const basic = sections.find((candidate) => candidate.kind === 'basic');
  const intent = sections.find((candidate) => candidate.kind === 'intent');
  const summary = sections.find((candidate) => candidate.kind === 'summary');
  const education = sections.find((candidate) => candidate.kind === 'education');
  const work = sections.find((candidate) => candidate.kind === 'work');
  const project = sections.find((candidate) => candidate.kind === 'project');
  const internship = sections.find((candidate) => candidate.kind === 'internship');
  const campus = sections.find((candidate) => candidate.kind === 'campus');
  const skills = sections.find((candidate) => candidate.kind === 'skillsCertificates');
  const awards = sections.find((candidate) => candidate.kind === 'awards');
  if (
    !basic ||
    !intent ||
    !summary ||
    !education ||
    !work ||
    !project ||
    !internship ||
    !campus ||
    !skills ||
    !awards
  ) {
    throw new Error('初始简历缺少原型所需模块');
  }
  const basicEntry = basic.entries[0];
  const intentEntry = intent.entries[0];
  const summaryEntry = summary.entries[0];
  if (!basicEntry || !intentEntry || !summaryEntry) {
    throw new Error('初始简历缺少原型所需单例条目');
  }

  basicEntry.name = '张三';
  basicEntry.phone = { value: '138 0013 8000', visible: true };
  basicEntry.email = { value: 'zhangsan@example.com', visible: true };
  basicEntry.city = { value: '上海', visible: true };
  basicEntry.links.push({
    id: nextId(),
    label: 'zhangsan.dev',
    url: 'https://zhangsan.dev',
    visible: true,
  });
  intentEntry.targetRole = '前端开发工程师';
  summary.title = '个人简介';
  summary.visible = true;
  summaryEntry.blocks.push({
    id: nextId(),
    text: '3 年前端开发经验，专注于复杂业务系统与高质量用户体验。擅长 React、TypeScript 与性能优化。',
  });
  education.entries.push({
    id: nextId(),
    school: '华东理工大学',
    major: '计算机科学与技术',
    degree: '本科',
    city: '',
    courses: [],
    grade: null,
    period: { start: '2018-09', end: '2022-06', current: false },
    bullets: [],
  });
  work.visible = true;
  work.entries.push({
    id: nextId(),
    organization: '远景科技有限公司',
    role: '前端开发工程师',
    city: '',
    employmentType: '',
    period: { start: '2022-07', end: null, current: true },
    bullets: [
      {
        id: nextId(),
        text: '负责公司核心业务系统的前端开发与维护，基于 React + TypeScript 构建高可维护的企业级应用。',
      },
      {
        id: nextId(),
        text: '通过性能优化与工程化改进，提升页面加载速度 40%，显著改善用户体验。',
      },
    ],
  });
  project.entries.push({
    id: nextId(),
    name: '智能运营数据平台',
    role: '核心开发',
    background: { id: nextId(), text: '' },
    actions: [
      {
        id: nextId(),
        text: '负责数据可视化模块的前端开发，使用 React + Ant Design 实现多维度数据展示与交互。',
      },
      { id: nextId(), text: '参与需求分析与技术方案设计，完成从 0 到 1 的项目落地。' },
    ],
    results: [],
    technologies: ['React', 'TypeScript', 'Ant Design'],
    links: [],
    period: { start: '2023-01', end: '2023-06', current: false },
    bullets: [],
  });
  skills.entries.push({
    id: nextId(),
    type: 'skill',
    name: 'React / TypeScript / JavaScript / HTML / CSS / Git',
    proficiency: null,
    issuer: null,
    obtainedAt: null,
    description: { id: nextId(), text: '' },
  });
  internship.visible = false;
  campus.visible = false;
  awards.visible = false;
  document.typography = {
    ...document.typography,
    bodyFontSizePt: 12,
    lineHeight: 1.55,
    sectionGapMm: 14.5,
    paragraphGapMm: 2.5,
  };
  document.page.marginMm = { top: 18, right: 20, bottom: 18, left: 20 };
  return document;
}

export async function seedFixedResume(
  pool: Pool,
  seed: FixedResumeSeed,
): Promise<FixedResumeSeedResult> {
  const schema = seed.schema ?? 'public';
  if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
  const document = createPrototypeDocument();
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
       values ($1, $2, '张三的简历', $3::jsonb, 1, 1, 'ats-basic', '1.0.0')
       on conflict (id) do nothing
       returning revision`,
      [seed.resumeId, seed.userId, JSON.stringify(document)],
    );

    if (inserted.rows[0]) {
      await client.query(
        `insert into resume_versions
          (id, resume_id, user_id, revision, title_snapshot, schema_version,
           template_id, template_version, renderer_version, snapshot, content_hash, reason)
         values ($1, $2, $3, 1, '张三的简历', 1,
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
