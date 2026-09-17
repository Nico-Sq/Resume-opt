import { type IdFactory } from './default';
import { ResumeDocumentV1Schema, type ContentSection, type ResumeDocumentV1 } from './schema';

export type EditablePrimitive = string | number | boolean | null;
export type StringListField = 'industries' | 'cities' | 'courses' | 'technologies';
export type TextBlockListField = 'bullets' | 'blocks' | 'actions' | 'results';

export type ResumeEditCommand =
  | {
      type: 'set-entry-field';
      sectionId: string;
      entryId: string;
      path: ReadonlyArray<string | number>;
      value: EditablePrimitive;
    }
  | { type: 'set-section-title'; sectionId: string; title: string }
  | {
      type: 'set-string-list-field';
      sectionId: string;
      entryId: string;
      field: StringListField;
      values: readonly string[];
    }
  | {
      type: 'add-text-block';
      sectionId: string;
      entryId: string;
      field: TextBlockListField;
      atIndex?: number;
    }
  | {
      type: 'remove-text-block';
      sectionId: string;
      entryId: string;
      field: TextBlockListField;
      blockId: string;
    }
  | {
      type: 'add-link';
      sectionId: string;
      entryId: string;
      atIndex?: number;
    }
  | { type: 'remove-link'; sectionId: string; entryId: string; linkId: string }
  | { type: 'add-entry'; sectionId: string; atIndex?: number }
  | { type: 'copy-entry'; sectionId: string; entryId: string }
  | { type: 'remove-entry'; sectionId: string; entryId: string }
  | { type: 'set-section-visibility'; sectionId: string; visible: boolean }
  | { type: 'reorder-sections'; moduleOrder: readonly string[] }
  | { type: 'move-section'; sectionId: string; toIndex: number }
  | { type: 'add-custom-section'; title: string; atIndex?: number }
  | { type: 'remove-custom-section'; sectionId: string }
  | { type: 'restore-default-section-layout' }
  | { type: 'set-template-reference'; templateId: string; templateVersion: string };

export type ResumeEditErrorCode =
  | 'DOCUMENT_INVALID'
  | 'SECTION_NOT_FOUND'
  | 'ENTRY_NOT_FOUND'
  | 'ITEM_NOT_FOUND'
  | 'INVALID_FIELD_PATH'
  | 'INVALID_POSITION'
  | 'UNSUPPORTED_OPERATION';

export class ResumeEditError extends Error {
  constructor(
    readonly code: ResumeEditErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ResumeEditError';
  }
}

const DEFAULT_SECTION_ORDER: ReadonlyArray<ContentSection['kind']> = [
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
];

const DEFAULT_SECTION_VISIBILITY: Readonly<Record<ContentSection['kind'], boolean>> = {
  basic: true,
  intent: true,
  summary: false,
  education: true,
  work: false,
  project: true,
  internship: true,
  campus: true,
  skillsCertificates: true,
  awards: true,
  selfEvaluation: true,
  custom: true,
};

const protectedPathParts = new Set(['__proto__', 'prototype', 'constructor', 'id']);

function invalid(code: ResumeEditErrorCode, message: string, details?: unknown): never {
  throw new ResumeEditError(code, message, details);
}

function parseDocument(document: ResumeDocumentV1): ResumeDocumentV1 {
  const result = ResumeDocumentV1Schema.safeParse(document);
  if (!result.success) {
    return invalid('DOCUMENT_INVALID', '编辑命令产生了无效的简历文档', result.error);
  }
  return result.data;
}

function findSection(document: ResumeDocumentV1, sectionId: string): ContentSection {
  const sectionValue = document.sectionsById[sectionId];
  if (!sectionValue) return invalid('SECTION_NOT_FOUND', '找不到指定模块', { sectionId });
  return sectionValue;
}

function findEntry(sectionValue: ContentSection, entryId: string): Record<string, unknown> {
  const entry = sectionValue.entries.find((candidate) => candidate.id === entryId);
  if (!entry) {
    return invalid('ENTRY_NOT_FOUND', '找不到指定条目', {
      sectionId: sectionValue.id,
      entryId,
    });
  }
  return entry as Record<string, unknown>;
}

function assertRepeatable(sectionValue: ContentSection): void {
  if (['basic', 'intent', 'summary', 'selfEvaluation'].includes(sectionValue.kind)) {
    invalid('UNSUPPORTED_OPERATION', '该模块的固定条目不能新增、复制或删除', {
      sectionId: sectionValue.id,
      kind: sectionValue.kind,
    });
  }
}

function insertAt<T>(items: T[], item: T, atIndex: number | undefined): void {
  const index = atIndex ?? items.length;
  if (!Number.isInteger(index) || index < 0 || index > items.length) {
    invalid('INVALID_POSITION', '插入位置超出范围', { atIndex, length: items.length });
  }
  items.splice(index, 0, item);
}

function createEntry(sectionValue: ContentSection, idFactory: IdFactory): unknown {
  const period = () => ({ start: null, end: null, current: false });
  const block = () => ({ id: idFactory(), text: '' });

  switch (sectionValue.kind) {
    case 'education':
      return {
        id: idFactory(),
        period: period(),
        bullets: [],
        school: '',
        major: '',
        degree: '',
        city: '',
        courses: [],
        grade: null,
      };
    case 'work':
    case 'internship':
      return {
        id: idFactory(),
        period: period(),
        bullets: [],
        organization: '',
        role: '',
        city: '',
        employmentType: '',
      };
    case 'project':
      return {
        id: idFactory(),
        period: period(),
        bullets: [],
        name: '',
        role: '',
        background: block(),
        actions: [],
        results: [],
        technologies: [],
        links: [],
      };
    case 'campus':
      return {
        id: idFactory(),
        period: period(),
        bullets: [],
        organization: '',
        role: '',
        activity: '',
      };
    case 'skillsCertificates':
      return {
        id: idFactory(),
        type: 'skill',
        name: '',
        proficiency: null,
        issuer: null,
        obtainedAt: null,
        description: block(),
      };
    case 'awards':
      return {
        id: idFactory(),
        name: '',
        level: '',
        issuer: '',
        awardedAt: null,
        description: block(),
      };
    case 'custom':
      return {
        id: idFactory(),
        period: period(),
        bullets: [],
        heading: '',
        subheading: '',
        links: [],
      };
    default:
      return invalid('UNSUPPORTED_OPERATION', '该模块不支持新增条目', {
        sectionId: sectionValue.id,
        kind: sectionValue.kind,
      });
  }
}

function cloneWithFreshIds(value: unknown, idFactory: IdFactory): unknown {
  if (Array.isArray(value)) return value.map((item) => cloneWithFreshIds(item, idFactory));
  if (value === null || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [
      key,
      key === 'id' ? idFactory() : cloneWithFreshIds(child, idFactory),
    ]),
  );
}

function setEntryField(
  entry: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
  value: EditablePrimitive,
): void {
  if (path.length === 0) invalid('INVALID_FIELD_PATH', '字段路径不能为空');

  let cursor: unknown = entry;
  for (let index = 0; index < path.length; index += 1) {
    const part = path[index];
    const isLast = index === path.length - 1;
    if (typeof part === 'string' && protectedPathParts.has(part)) {
      invalid('INVALID_FIELD_PATH', '字段路径不能修改标识或原型属性', { path });
    }

    if (Array.isArray(cursor)) {
      if (
        !Number.isInteger(part) ||
        typeof part !== 'number' ||
        part < 0 ||
        part >= cursor.length
      ) {
        invalid('INVALID_FIELD_PATH', '数组字段路径超出范围', { path });
      }
      if (isLast) {
        if (cursor[part] !== null && typeof cursor[part] === 'object') {
          invalid('INVALID_FIELD_PATH', '字段命令只能修改现有标量值', { path });
        }
        cursor[part] = value;
        return;
      }
      cursor = cursor[part];
      continue;
    }

    if (cursor === null || typeof cursor !== 'object' || typeof part !== 'string') {
      invalid('INVALID_FIELD_PATH', '字段路径不存在', { path });
    }
    if (!Object.prototype.hasOwnProperty.call(cursor, part)) {
      invalid('INVALID_FIELD_PATH', '字段路径不存在', { path });
    }

    const record = cursor as Record<string, unknown>;
    if (isLast) {
      if (record[part] !== null && typeof record[part] === 'object') {
        invalid('INVALID_FIELD_PATH', '字段命令只能修改现有标量值', { path });
      }
      record[part] = value;
      return;
    }
    cursor = record[part];
  }
}

function findArrayField(
  entry: Record<string, unknown>,
  field: string,
  itemName: string,
): unknown[] {
  if (!Object.prototype.hasOwnProperty.call(entry, field) || !Array.isArray(entry[field])) {
    return invalid('UNSUPPORTED_OPERATION', `该条目不支持${itemName}列表`, { field });
  }
  return entry[field];
}

function findIdentifiedItemIndex(items: unknown[], itemId: string, itemName: string): number {
  const index = items.findIndex(
    (item) =>
      item !== null &&
      typeof item === 'object' &&
      'id' in item &&
      (item as { id?: unknown }).id === itemId,
  );
  if (index < 0) return invalid('ITEM_NOT_FOUND', `找不到指定${itemName}`, { itemId });
  return index;
}

function applyCommand(
  document: ResumeDocumentV1,
  command: ResumeEditCommand,
  idFactory: IdFactory,
): void {
  switch (command.type) {
    case 'set-entry-field': {
      const sectionValue = findSection(document, command.sectionId);
      setEntryField(findEntry(sectionValue, command.entryId), command.path, command.value);
      return;
    }
    case 'set-section-title':
      findSection(document, command.sectionId).title = command.title;
      return;
    case 'set-string-list-field': {
      const entry = findEntry(findSection(document, command.sectionId), command.entryId);
      const items = findArrayField(entry, command.field, '字符串');
      if (!items.every((item) => typeof item === 'string')) {
        invalid('UNSUPPORTED_OPERATION', '目标字段不是字符串列表', { field: command.field });
      }
      entry[command.field] = [...command.values];
      return;
    }
    case 'add-text-block': {
      const entry = findEntry(findSection(document, command.sectionId), command.entryId);
      const blocks = findArrayField(entry, command.field, '文本块');
      if (
        !blocks.every(
          (block) =>
            block !== null && typeof block === 'object' && 'id' in block && 'text' in block,
        )
      ) {
        invalid('UNSUPPORTED_OPERATION', '目标字段不是文本块列表', { field: command.field });
      }
      insertAt(blocks, { id: idFactory(), text: '' }, command.atIndex);
      return;
    }
    case 'remove-text-block': {
      const entry = findEntry(findSection(document, command.sectionId), command.entryId);
      const blocks = findArrayField(entry, command.field, '文本块');
      blocks.splice(findIdentifiedItemIndex(blocks, command.blockId, '文本块'), 1);
      return;
    }
    case 'add-link': {
      const entry = findEntry(findSection(document, command.sectionId), command.entryId);
      const links = findArrayField(entry, 'links', '链接');
      if (
        !links.every(
          (link) =>
            link !== null &&
            typeof link === 'object' &&
            'id' in link &&
            'label' in link &&
            'url' in link &&
            'visible' in link,
        )
      ) {
        invalid('UNSUPPORTED_OPERATION', '目标字段不是链接列表');
      }
      insertAt(links, { id: idFactory(), label: '', url: '', visible: true }, command.atIndex);
      return;
    }
    case 'remove-link': {
      const entry = findEntry(findSection(document, command.sectionId), command.entryId);
      const links = findArrayField(entry, 'links', '链接');
      links.splice(findIdentifiedItemIndex(links, command.linkId, '链接'), 1);
      return;
    }
    case 'add-entry': {
      const sectionValue = findSection(document, command.sectionId);
      assertRepeatable(sectionValue);
      insertAt(
        sectionValue.entries as unknown[],
        createEntry(sectionValue, idFactory),
        command.atIndex,
      );
      return;
    }
    case 'copy-entry': {
      const sectionValue = findSection(document, command.sectionId);
      assertRepeatable(sectionValue);
      const sourceIndex = sectionValue.entries.findIndex((entry) => entry.id === command.entryId);
      if (sourceIndex < 0) {
        invalid('ENTRY_NOT_FOUND', '找不到指定条目', {
          sectionId: sectionValue.id,
          entryId: command.entryId,
        });
      }
      const entries = sectionValue.entries as unknown[];
      const source = entries[sourceIndex];
      entries.splice(sourceIndex + 1, 0, cloneWithFreshIds(source, idFactory));
      return;
    }
    case 'remove-entry': {
      const sectionValue = findSection(document, command.sectionId);
      assertRepeatable(sectionValue);
      const index = sectionValue.entries.findIndex((entry) => entry.id === command.entryId);
      if (index < 0) {
        invalid('ENTRY_NOT_FOUND', '找不到指定条目', {
          sectionId: sectionValue.id,
          entryId: command.entryId,
        });
      }
      sectionValue.entries.splice(index, 1);
      return;
    }
    case 'set-section-visibility':
      findSection(document, command.sectionId).visible = command.visible;
      return;
    case 'reorder-sections':
      document.moduleOrder = [...command.moduleOrder];
      return;
    case 'move-section': {
      if (
        !Number.isInteger(command.toIndex) ||
        command.toIndex < 0 ||
        command.toIndex >= document.moduleOrder.length
      ) {
        invalid('INVALID_POSITION', '模块目标位置超出范围', {
          toIndex: command.toIndex,
          length: document.moduleOrder.length,
        });
      }
      const fromIndex = document.moduleOrder.indexOf(command.sectionId);
      if (fromIndex < 0) {
        invalid('SECTION_NOT_FOUND', '找不到指定模块', { sectionId: command.sectionId });
      }
      const [sectionId] = document.moduleOrder.splice(fromIndex, 1);
      if (!sectionId) invalid('SECTION_NOT_FOUND', '找不到指定模块');
      document.moduleOrder.splice(command.toIndex, 0, sectionId);
      return;
    }
    case 'add-custom-section': {
      const sectionId = idFactory();
      document.sectionsById[sectionId] = {
        id: sectionId,
        kind: 'custom',
        title: command.title,
        visible: true,
        entries: [],
      };
      insertAt(document.moduleOrder, sectionId, command.atIndex);
      return;
    }
    case 'remove-custom-section': {
      const sectionValue = findSection(document, command.sectionId);
      if (sectionValue.kind !== 'custom') {
        invalid('UNSUPPORTED_OPERATION', '标准模块不能删除', {
          sectionId: sectionValue.id,
          kind: sectionValue.kind,
        });
      }
      document.sectionsById = Object.fromEntries(
        Object.entries(document.sectionsById).filter(([id]) => id !== command.sectionId),
      );
      document.moduleOrder = document.moduleOrder.filter((id) => id !== command.sectionId);
      document.typography.moduleOverrides = Object.fromEntries(
        Object.entries(document.typography.moduleOverrides).filter(
          ([id]) => id !== command.sectionId,
        ),
      );
      return;
    }
    case 'restore-default-section-layout': {
      const rank = new Map(DEFAULT_SECTION_ORDER.map((kind, index) => [kind, index]));
      const standardIds = document.moduleOrder
        .filter((id) => document.sectionsById[id]?.kind !== 'custom')
        .sort((left, right) => {
          const leftKind = document.sectionsById[left]?.kind;
          const rightKind = document.sectionsById[right]?.kind;
          return (
            (leftKind ? (rank.get(leftKind) ?? 999) : 999) -
            (rightKind ? (rank.get(rightKind) ?? 999) : 999)
          );
        });
      const customIds = document.moduleOrder.filter(
        (id) => document.sectionsById[id]?.kind === 'custom',
      );
      document.moduleOrder = [...standardIds, ...customIds];
      for (const id of standardIds) {
        const sectionValue = document.sectionsById[id];
        if (sectionValue) sectionValue.visible = DEFAULT_SECTION_VISIBILITY[sectionValue.kind];
      }
      return;
    }
    case 'set-template-reference':
      document.templateId = command.templateId;
      document.templateVersion = command.templateVersion;
      return;
  }
}

export function applyResumeEditCommand(
  document: ResumeDocumentV1,
  command: ResumeEditCommand,
  options: { idFactory?: IdFactory } = {},
): ResumeDocumentV1 {
  const nextDocument = parseDocument(document);
  applyCommand(nextDocument, command, options.idFactory ?? (() => crypto.randomUUID()));
  return parseDocument(nextDocument);
}
