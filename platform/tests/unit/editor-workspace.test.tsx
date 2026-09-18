// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createInitialResumeDocument,
  type ContentSection,
  type ResumeDocumentV1,
} from '@resume/domain/resume';
import { EditorWorkspace } from '../../apps/web/src/client/editor/editor-workspace';
import { createResumeEditorStore } from '../../apps/web/src/client/editor/store';

function deterministicIds() {
  let counter = 1;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function sectionByKind<K extends ContentSection['kind']>(document: ResumeDocumentV1, kind: K) {
  const sectionValue = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: K }> => candidate.kind === kind,
  );
  if (!sectionValue) throw new Error(`fixture 缺少 ${kind} 模块`);
  return sectionValue;
}

function createFixture() {
  const nextId = deterministicIds();
  const document = createInitialResumeDocument(nextId);
  const basicEntry = sectionByKind(document, 'basic').entries[0];
  if (!basicEntry) throw new Error('fixture 缺少基本信息条目');
  basicEntry.name = '林小满';
  const education = sectionByKind(document, 'education');
  education.entries.push({
    id: nextId(),
    school: '示例大学',
    major: '计算机科学',
    degree: '本科',
    city: '上海',
    courses: [],
    grade: null,
    period: { start: '2020-09', end: '2024-06', current: false },
    bullets: [{ id: nextId(), text: '完成课程设计' }],
  });
  const project = sectionByKind(document, 'project');
  project.entries.push({
    id: nextId(),
    name: 'AI 简历平台',
    role: '独立开发者',
    background: { id: nextId(), text: '构建可靠的结构化编辑器' },
    actions: [],
    results: [],
    technologies: ['TypeScript'],
    links: [],
    period: { start: '2025-01', end: null, current: true },
    bullets: [],
  });
  const store = createResumeEditorStore({ document, revision: '1' });
  return {
    document,
    store,
    resume: { id: nextId(), title: '产品工程师简历', document, revision: '1' },
  };
}

afterEach(() => {
  cleanup();
});

describe('editor workspace module management', () => {
  it('moves modules from the keyboard, announces the result and preserves focus', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    const education = sectionByKind(store.getState().document, 'education');
    const handle = screen.getByRole('button', {
      name: '拖动教育背景，可使用上下方向键排序',
    });
    const before = store.getState().document.moduleOrder.indexOf(education.id);

    handle.focus();
    await user.keyboard('{ArrowUp}');

    expect(store.getState().document.moduleOrder.indexOf(education.id)).toBe(before - 1);
    await waitFor(() => {
      expect(document.activeElement).toBe(handle);
    });
    expect(screen.getByRole('status', { name: '模块操作通知' }).textContent).toContain(
      '教育背景已移动到第',
    );
    const items = within(screen.getByRole('list', { name: '模块顺序' })).getAllByRole('listitem');
    expect(items[before - 1]?.textContent).toContain('教育背景');
  });

  it('hides a module without deleting content and updates the shared A4 preview immediately', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const { container } = render(<EditorWorkspace initialResume={resume} store={store} />);
    const education = sectionByKind(store.getState().document, 'education');
    const entryIds = education.entries.map((entry) => entry.id);

    expect(
      [...container.querySelectorAll('.resume-page .resume-section-heading')].map(
        (node) => node.textContent,
      ),
    ).toContain('教育背景');
    const visibility = screen.getByRole('switch', { name: '隐藏教育背景' });
    await user.click(visibility);

    expect(sectionByKind(store.getState().document, 'education').visible).toBe(false);
    expect(
      sectionByKind(store.getState().document, 'education').entries.map((entry) => entry.id),
    ).toEqual(entryIds);
    expect(
      [...container.querySelectorAll('.resume-page .resume-section-heading')].map(
        (node) => node.textContent,
      ),
    ).not.toContain('教育背景');
    await waitFor(() => {
      expect(document.activeElement).toBe(visibility);
    });
    expect(screen.getByRole('status', { name: '模块操作通知' }).textContent).toBe('教育背景已隐藏');
  });

  it('restores default order and visibility while keeping the restore control focused', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    const education = sectionByKind(store.getState().document, 'education');
    store.getState().dispatch({
      type: 'move-section',
      sectionId: education.id,
      toIndex: store.getState().document.moduleOrder.length - 1,
    });
    store.getState().dispatch({
      type: 'set-section-visibility',
      sectionId: education.id,
      visible: false,
    });
    const restore = screen.getByRole('button', { name: '恢复默认顺序与显示' });

    await user.click(restore);

    expect(store.getState().document.moduleOrder.indexOf(education.id)).toBe(3);
    expect(sectionByKind(store.getState().document, 'education').visible).toBe(true);
    await waitFor(() => {
      expect(document.activeElement).toBe(restore);
    });
    expect(screen.getByRole('status', { name: '模块操作通知' }).textContent).toBe(
      '已恢复默认模块顺序和显示状态',
    );
  });

  it('independently collapses both content panels while preserving the icon rails', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    const contentPanel = screen.getByRole('complementary', { name: '内容编辑' });
    const settingsPanel = screen.getByRole('complementary', { name: '布局设置' });

    const collapseContent = screen.getAllByRole('button', { name: '收起内容面板' })[0];
    if (!collapseContent) throw new Error('缺少内容面板收起按钮');
    await user.click(collapseContent);
    await user.click(screen.getByRole('button', { name: '收起模块布局设置' }));

    expect(contentPanel.hidden).toBe(true);
    expect(settingsPanel.hidden).toBe(true);
    expect(screen.getByRole('navigation', { name: '简历模块' })).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole('navigation', { name: '编辑器工具' })).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole('button', { name: '展开内容面板' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(
      screen.getByRole('button', { name: '展开模块布局设置' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});
