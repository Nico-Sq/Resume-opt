import { describe, expect, it } from 'vitest';

import {
  applyResumeEditCommand,
  createInitialResumeDocument,
  ResumeDocumentV1Schema,
  ResumeEditError,
  type ContentSection,
  type ResumeDocumentV1,
} from '@resume/domain/resume';

function deterministicIds(start = 1) {
  let counter = start;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function createDocument() {
  return createInitialResumeDocument(deterministicIds());
}

function sectionByKind<K extends ContentSection['kind']>(
  document: ResumeDocumentV1,
  kind: K,
): Extract<ContentSection, { kind: K }> {
  const sectionValue = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: K }> => candidate.kind === kind,
  );
  if (!sectionValue) throw new Error(`fixture 缺少 ${kind} 模块`);
  return sectionValue;
}

function collectIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(collectIds);
  if (value === null || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) =>
    key === 'id' && typeof child === 'string' ? [child] : collectIds(child),
  );
}

function withoutIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutIds);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'id')
      .map(([key, child]) => [key, withoutIds(child)]),
  );
}

describe('resume edit commands', () => {
  it('updates existing scalar fields without mutating the source or changing IDs', () => {
    const source = createDocument();
    const project = sectionByKind(source, 'project');
    const withEntry = applyResumeEditCommand(
      source,
      { type: 'add-entry', sectionId: project.id },
      { idFactory: deterministicIds(500) },
    );
    const entry = sectionByKind(withEntry, 'project').entries[0];
    if (!entry) throw new Error('fixture 缺少项目条目');
    const idsBefore = collectIds(withEntry);

    const renamed = applyResumeEditCommand(withEntry, {
      type: 'set-entry-field',
      sectionId: project.id,
      entryId: entry.id,
      path: ['name'],
      value: 'AI 简历平台',
    });
    const updated = applyResumeEditCommand(renamed, {
      type: 'set-entry-field',
      sectionId: project.id,
      entryId: entry.id,
      path: ['background', 'text'],
      value: '解决结构化编辑与可靠保存问题',
    });

    expect(sectionByKind(source, 'project').entries).toEqual([]);
    expect(sectionByKind(updated, 'project').entries[0]).toMatchObject({
      name: 'AI 简历平台',
      background: { text: '解决结构化编辑与可靠保存问题' },
    });
    expect(collectIds(updated)).toEqual(idsBefore);
  });

  it('rejects unknown, structural and identity field paths', () => {
    const source = createDocument();
    const basic = sectionByKind(source, 'basic');
    const entry = basic.entries[0];
    if (!entry) throw new Error('fixture 缺少基本信息条目');

    for (const path of [['missing'], ['id'], ['phone']] as const) {
      expect(() =>
        applyResumeEditCommand(source, {
          type: 'set-entry-field',
          sectionId: basic.id,
          entryId: entry.id,
          path,
          value: '非法修改',
        }),
      ).toThrow(ResumeEditError);
    }
  });

  it('edits string lists, text blocks and links through structural commands', () => {
    const source = createDocument();
    const projectId = sectionByKind(source, 'project').id;
    const withEntry = applyResumeEditCommand(
      source,
      { type: 'add-entry', sectionId: projectId },
      { idFactory: deterministicIds(500) },
    );
    const entry = sectionByKind(withEntry, 'project').entries[0];
    if (!entry) throw new Error('fixture 缺少项目条目');

    const withTechnologies = applyResumeEditCommand(withEntry, {
      type: 'set-string-list-field',
      sectionId: projectId,
      entryId: entry.id,
      field: 'technologies',
      values: ['TypeScript', 'PostgreSQL'],
    });
    const withBlock = applyResumeEditCommand(
      withTechnologies,
      {
        type: 'add-text-block',
        sectionId: projectId,
        entryId: entry.id,
        field: 'actions',
      },
      { idFactory: deterministicIds(600) },
    );
    const block = sectionByKind(withBlock, 'project').entries[0]?.actions[0];
    if (!block) throw new Error('fixture 缺少行动文本块');
    const withBlockText = applyResumeEditCommand(withBlock, {
      type: 'set-entry-field',
      sectionId: projectId,
      entryId: entry.id,
      path: ['actions', 0, 'text'],
      value: '实现结构化编辑命令',
    });
    const withLink = applyResumeEditCommand(
      withBlockText,
      { type: 'add-link', sectionId: projectId, entryId: entry.id },
      { idFactory: deterministicIds(700) },
    );
    const link = sectionByKind(withLink, 'project').entries[0]?.links[0];
    if (!link) throw new Error('fixture 缺少项目链接');
    const withLinkUrl = applyResumeEditCommand(withLink, {
      type: 'set-entry-field',
      sectionId: projectId,
      entryId: entry.id,
      path: ['links', 0, 'url'],
      value: 'https://example.com/resume',
    });

    expect(sectionByKind(withLinkUrl, 'project').entries[0]).toMatchObject({
      technologies: ['TypeScript', 'PostgreSQL'],
      actions: [{ id: block.id, text: '实现结构化编辑命令' }],
      links: [{ id: link.id, url: 'https://example.com/resume', visible: true }],
    });

    const withoutBlock = applyResumeEditCommand(withLinkUrl, {
      type: 'remove-text-block',
      sectionId: projectId,
      entryId: entry.id,
      field: 'actions',
      blockId: block.id,
    });
    const withoutLink = applyResumeEditCommand(withoutBlock, {
      type: 'remove-link',
      sectionId: projectId,
      entryId: entry.id,
      linkId: link.id,
    });
    expect(sectionByKind(withoutLink, 'project').entries[0]).toMatchObject({
      actions: [],
      links: [],
    });
  });

  it.each([
    'education',
    'work',
    'project',
    'internship',
    'campus',
    'skillsCertificates',
    'awards',
  ] as const)('creates a valid default entry for the %s module', (kind) => {
    const source = createDocument();
    const sectionValue = sectionByKind(source, kind);
    const updated = applyResumeEditCommand(
      source,
      { type: 'add-entry', sectionId: sectionValue.id, atIndex: 0 },
      { idFactory: deterministicIds(500) },
    );

    expect(sectionByKind(updated, kind).entries).toHaveLength(1);
    expect(ResumeDocumentV1Schema.safeParse(updated).success).toBe(true);
  });

  it('copies an entry next to its source and allocates fresh IDs for the whole subtree', () => {
    const source = createDocument();
    const projectId = sectionByKind(source, 'project').id;
    const withEntry = applyResumeEditCommand(
      source,
      { type: 'add-entry', sectionId: projectId },
      { idFactory: deterministicIds(500) },
    );
    const originalEntry = sectionByKind(withEntry, 'project').entries[0];
    if (!originalEntry) throw new Error('fixture 缺少项目条目');

    const copied = applyResumeEditCommand(
      withEntry,
      { type: 'copy-entry', sectionId: projectId, entryId: originalEntry.id },
      { idFactory: deterministicIds(600) },
    );
    const [first, second] = sectionByKind(copied, 'project').entries;
    if (!first || !second) throw new Error('复制结果缺少条目');

    expect(withoutIds(second)).toEqual(withoutIds(first));
    const firstIds = new Set(collectIds(first));
    expect(collectIds(second).every((id) => !firstIds.has(id))).toBe(true);
  });

  it('removes only the requested repeatable entry and protects fixed entries', () => {
    const source = createDocument();
    const educationId = sectionByKind(source, 'education').id;
    const withEntry = applyResumeEditCommand(
      source,
      { type: 'add-entry', sectionId: educationId },
      { idFactory: deterministicIds(500) },
    );
    const entry = sectionByKind(withEntry, 'education').entries[0];
    if (!entry) throw new Error('fixture 缺少教育条目');

    const removed = applyResumeEditCommand(withEntry, {
      type: 'remove-entry',
      sectionId: educationId,
      entryId: entry.id,
    });
    expect(sectionByKind(removed, 'education').entries).toEqual([]);

    const basic = sectionByKind(source, 'basic');
    expect(() =>
      applyResumeEditCommand(source, {
        type: 'remove-entry',
        sectionId: basic.id,
        entryId: basic.entries[0]?.id ?? '',
      }),
    ).toThrow('固定条目不能新增、复制或删除');
  });

  it('hides and reorders modules without changing content or other visibility states', () => {
    const source = createDocument();
    const campusId = sectionByKind(source, 'campus').id;
    const hidden = applyResumeEditCommand(source, {
      type: 'set-section-visibility',
      sectionId: campusId,
      visible: false,
    });

    expect(hidden.sectionsById[campusId]?.visible).toBe(false);
    expect(hidden.sectionsById[campusId]?.entries).toEqual(source.sectionsById[campusId]?.entries);

    const reversedOrder = [...hidden.moduleOrder].reverse();
    const reordered = applyResumeEditCommand(hidden, {
      type: 'reorder-sections',
      moduleOrder: reversedOrder,
    });
    expect(reordered.moduleOrder).toEqual(reversedOrder);
    expect(reordered.sectionsById).toEqual(hidden.sectionsById);
  });

  it('moves one module with bounded positions and rejects incomplete orders', () => {
    const source = createDocument();
    const projectId = sectionByKind(source, 'project').id;
    const moved = applyResumeEditCommand(source, {
      type: 'move-section',
      sectionId: projectId,
      toIndex: 0,
    });

    expect(moved.moduleOrder[0]).toBe(projectId);
    expect(moved.sectionsById).toEqual(source.sectionsById);
    expect(() =>
      applyResumeEditCommand(source, {
        type: 'reorder-sections',
        moduleOrder: source.moduleOrder.slice(1),
      }),
    ).toThrow(ResumeEditError);
  });

  it('adds and removes custom modules while protecting standard modules', () => {
    const source = createDocument();
    const added = applyResumeEditCommand(
      source,
      { type: 'add-custom-section', title: '开源贡献', atIndex: 2 },
      { idFactory: deterministicIds(900) },
    );
    const custom = sectionByKind(added, 'custom');

    expect(added.moduleOrder[2]).toBe(custom.id);
    expect(custom).toMatchObject({ title: '开源贡献', visible: true, entries: [] });

    const removed = applyResumeEditCommand(added, {
      type: 'remove-custom-section',
      sectionId: custom.id,
    });
    expect(removed.sectionsById[custom.id]).toBeUndefined();
    expect(removed.moduleOrder).not.toContain(custom.id);

    expect(() =>
      applyResumeEditCommand(source, {
        type: 'remove-custom-section',
        sectionId: sectionByKind(source, 'education').id,
      }),
    ).toThrow('标准模块不能删除');
  });

  it('restores the default standard layout without deleting content or custom modules', () => {
    const source = createDocument();
    const withCustom = applyResumeEditCommand(
      source,
      { type: 'add-custom-section', title: '开源贡献', atIndex: 0 },
      { idFactory: deterministicIds(900) },
    );
    const custom = sectionByKind(withCustom, 'custom');
    const basicId = sectionByKind(withCustom, 'basic').id;
    const changed = applyResumeEditCommand(
      applyResumeEditCommand(withCustom, {
        type: 'set-section-visibility',
        sectionId: basicId,
        visible: false,
      }),
      { type: 'reorder-sections', moduleOrder: [...withCustom.moduleOrder].reverse() },
    );

    const restored = applyResumeEditCommand(changed, {
      type: 'restore-default-section-layout',
    });

    expect(restored.moduleOrder.at(-1)).toBe(custom.id);
    expect(restored.sectionsById[custom.id]).toEqual(withCustom.sectionsById[custom.id]);
    expect(restored.sectionsById[basicId]?.visible).toBe(true);
    expect(restored.moduleOrder.map((id) => restored.sectionsById[id]?.kind)).toEqual([
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
      'custom',
    ]);
  });

  it('changes template references without modifying resume content', () => {
    const source = createDocument();
    const updated = applyResumeEditCommand(source, {
      type: 'set-template-reference',
      templateId: 'ats-compact',
      templateVersion: '2.0.0',
    });

    expect(updated).toMatchObject({ templateId: 'ats-compact', templateVersion: '2.0.0' });
    expect(updated.sectionsById).toEqual(source.sectionsById);
    expect(updated.moduleOrder).toEqual(source.moduleOrder);
  });

  it('rejects generated ID collisions instead of silently corrupting the document', () => {
    const source = createDocument();
    const educationId = sectionByKind(source, 'education').id;
    const duplicateId = source.moduleOrder[0];
    if (!duplicateId) throw new Error('fixture 缺少模块');

    expect(() =>
      applyResumeEditCommand(
        source,
        { type: 'add-entry', sectionId: educationId },
        { idFactory: () => duplicateId },
      ),
    ).toThrow(ResumeEditError);
  });
});
