import { describe, expect, it } from 'vitest';

import {
  createInitialResumeDocument,
  migrateResumeDocument,
  ResumeDocumentV1Schema,
  SchemaVersionUnsupportedError,
  type ResumeDocumentV1,
} from '@resume/domain/resume';

function deterministicIds() {
  let counter = 1;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function createDocument() {
  return createInitialResumeDocument(deterministicIds());
}

function firstSection(document: ResumeDocumentV1) {
  const id = document.moduleOrder[0];
  if (!id) throw new Error('fixture 缺少模块');
  const sectionValue = document.sectionsById[id];
  if (!sectionValue) throw new Error('fixture 模块顺序无对应内容');
  return sectionValue;
}

describe('ResumeDocumentV1', () => {
  it('creates a valid initial document with all standard modules', () => {
    const document = createDocument();

    expect(ResumeDocumentV1Schema.parse(document)).toEqual(document);
    expect(
      new Set(Object.values(document.sectionsById).map((sectionValue) => sectionValue.kind)),
    ).toEqual(
      new Set([
        'basic',
        'intent',
        'summary',
        'education',
        'work',
        'project',
        'internship',
        'campus',
        'skillsCertificates',
        'awards',
        'selfEvaluation',
      ]),
    );
  });

  it('accepts a hidden custom module without deleting its content', () => {
    const document = createDocument();
    const id = '00000000-0000-4000-8000-000000000099';
    document.sectionsById[id] = {
      id,
      kind: 'custom',
      title: '开源贡献',
      visible: false,
      entries: [],
    };
    document.moduleOrder.push(id);

    const parsed = ResumeDocumentV1Schema.parse(document);
    expect(parsed.sectionsById[id]?.visible).toBe(false);
    expect(parsed.sectionsById[id]?.title).toBe('开源贡献');
  });

  it('accepts populated entries for every supported module kind', () => {
    const document = createDocument();
    let counter = 100;
    const nextId = () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}` as const;
    const period = { start: '2024-01', end: '2024-06', current: false } as const;
    const block = (text: string) => ({ id: nextId(), text });

    for (const sectionValue of Object.values(document.sectionsById)) {
      switch (sectionValue.kind) {
        case 'education':
          sectionValue.entries = [
            {
              id: nextId(),
              period,
              bullets: [block('主修课程与成绩说明')],
              school: '示例大学',
              major: '计算机科学',
              degree: '本科',
              city: '上海',
              courses: ['数据结构'],
              grade: '前 20%',
            },
          ];
          break;
        case 'work':
        case 'internship':
          sectionValue.entries = [
            {
              id: nextId(),
              period,
              bullets: [block('完成可验证的项目交付')],
              organization: '示例公司',
              role: '前端工程师',
              city: '上海',
              employmentType: '全职',
            },
          ];
          break;
        case 'project':
          sectionValue.entries = [
            {
              id: nextId(),
              period,
              bullets: [block('负责项目交付')],
              name: '简历平台',
              role: '负责人',
              background: block('解决简历编辑可靠性问题'),
              actions: [block('设计结构化编辑模型')],
              results: [block('完成可靠性验证')],
              technologies: ['TypeScript'],
              links: [
                { id: nextId(), label: '项目链接', url: 'https://example.com', visible: true },
              ],
            },
          ];
          break;
        case 'campus':
          sectionValue.entries = [
            {
              id: nextId(),
              period,
              bullets: [block('组织技术活动')],
              organization: '技术社团',
              role: '负责人',
              activity: '组织分享与复盘',
            },
          ];
          break;
        case 'skillsCertificates':
          sectionValue.entries = [
            {
              id: nextId(),
              type: 'skill',
              name: 'TypeScript',
              proficiency: null,
              issuer: null,
              obtainedAt: null,
              description: block('能够完成全栈开发'),
            },
          ];
          break;
        case 'awards':
          sectionValue.entries = [
            {
              id: nextId(),
              name: '示例奖项',
              level: '校级',
              issuer: '示例大学',
              awardedAt: '2024-06',
              description: block('基于真实事实的说明'),
            },
          ];
          break;
        default:
          break;
      }
    }

    const customId = nextId();
    document.sectionsById[customId] = {
      id: customId,
      kind: 'custom',
      title: '开源贡献',
      visible: true,
      entries: [
        {
          id: nextId(),
          period,
          bullets: [block('提交经过验证的修复')],
          heading: '示例项目',
          subheading: '贡献者',
          links: [],
        },
      ],
    };
    document.moduleOrder.push(customId);

    expect(ResumeDocumentV1Schema.safeParse(document).success).toBe(true);
  });

  it('rejects duplicated IDs anywhere in the document', () => {
    const document = createDocument();
    const basic = firstSection(document);
    if (basic.kind !== 'basic' || !basic.entries[0]) throw new Error('fixture 基本信息无效');
    basic.entries[0].id = basic.id;

    expect(() => ResumeDocumentV1Schema.parse(document)).toThrow('文档内所有 ID 必须唯一');
  });

  it.each([
    ['missing', (document: ResumeDocumentV1) => document.moduleOrder.pop()],
    [
      'duplicate',
      (document: ResumeDocumentV1) => {
        const firstId = document.moduleOrder[0];
        if (firstId) document.moduleOrder.push(firstId);
      },
    ],
  ])('rejects a %s module order entry', (_name, mutate) => {
    const document = createDocument();
    mutate(document);

    expect(() => ResumeDocumentV1Schema.parse(document)).toThrow(
      '模块顺序必须无重复并完整覆盖全部模块',
    );
  });

  it('rejects unknown fields instead of silently stripping them', () => {
    const document = { ...createDocument(), unexpected: true };
    expect(() => ResumeDocumentV1Schema.parse(document)).toThrow();
  });

  it('rejects unsupported future versions without mutating the input', () => {
    const document = { ...createDocument(), schemaVersion: 2 };
    expect(() => migrateResumeDocument(document)).toThrow(SchemaVersionUnsupportedError);
    expect(document.schemaVersion).toBe(2);
  });

  it('rejects unsafe link protocols', () => {
    const document = createDocument();
    const basic = firstSection(document);
    if (basic.kind !== 'basic' || !basic.entries[0]) throw new Error('fixture 基本信息无效');
    basic.entries[0].links.push({
      id: '00000000-0000-4000-8000-000000000099',
      label: '危险链接',
      url: 'javascript:alert(1)',
      visible: true,
    });

    expect(() => ResumeDocumentV1Schema.parse(document)).toThrow('链接只允许');
  });

  it('rejects unknown top-level schema versions', () => {
    expect(() => migrateResumeDocument({ title: 'missing version' })).toThrow(
      SchemaVersionUnsupportedError,
    );
  });
});
