import type { ResumeDocumentV1 } from '@resume/domain/resume';

export type ConflictChangeKind = 'local-only' | 'remote-only' | 'same-change' | 'diverged';

export interface ConflictChange {
  key: string;
  label: string;
  kind: ConflictChangeKind;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function classify(base: unknown, local: unknown, remote: unknown): ConflictChangeKind | null {
  const localChanged = !same(base, local);
  const remoteChanged = !same(base, remote);
  if (!localChanged && !remoteChanged) return null;
  if (localChanged && !remoteChanged) return 'local-only';
  if (!localChanged && remoteChanged) return 'remote-only';
  return same(local, remote) ? 'same-change' : 'diverged';
}

export function buildThreeWayConflictChanges(
  base: ResumeDocumentV1,
  local: ResumeDocumentV1,
  remote: ResumeDocumentV1,
): ConflictChange[] {
  const changes: ConflictChange[] = [];
  const add = (
    key: string,
    label: string,
    baseValue: unknown,
    localValue: unknown,
    remoteValue: unknown,
  ) => {
    const kind = classify(baseValue, localValue, remoteValue);
    if (kind) changes.push({ key, label, kind });
  };

  const sectionIds = new Set([
    ...Object.keys(base.sectionsById),
    ...Object.keys(local.sectionsById),
    ...Object.keys(remote.sectionsById),
  ]);
  for (const sectionId of sectionIds) {
    const baseSection = base.sectionsById[sectionId];
    const localSection = local.sectionsById[sectionId];
    const remoteSection = remote.sectionsById[sectionId];
    const label = localSection?.title ?? remoteSection?.title ?? baseSection?.title ?? '未知模块';
    add(`section:${sectionId}`, label, baseSection, localSection, remoteSection);
  }
  add('module-order', '模块顺序', base.moduleOrder, local.moduleOrder, remote.moduleOrder);
  add(
    'template',
    '模板',
    [base.templateId, base.templateVersion],
    [local.templateId, local.templateVersion],
    [remote.templateId, remote.templateVersion],
  );
  add('typography', '排版设置', base.typography, local.typography, remote.typography);
  add('page', '页面设置', base.page, local.page, remote.page);
  add('design', '视觉设置', base.design, local.design, remote.design);
  return changes;
}
