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
