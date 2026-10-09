// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createInitialResumeDocument,
  type ContentSection,
  type ResumeDocumentV1,
} from '@resume/domain/resume';
import { EditorWorkspace } from '../../apps/web/src/client/editor/editor-workspace';
import type { ConflictSnapshotTransport } from '../../apps/web/src/client/editor/conflict';
import {
  LocalDraftUnavailableError,
  type AcknowledgePendingInput,
  type LocalDraftRecord,
  type LocalDraftRepository,
  type LocalDraftScope,
  type PendingSaveEnvelope,
} from '../../apps/web/src/client/editor/persistence';
import {
  SaveTransportError,
  type RenameResumeRequest,
  type RenameTransport,
  type SaveTransport,
} from '../../apps/web/src/client/editor/saving';
import { createResumeEditorStore } from '../../apps/web/src/client/editor/store';

class MemoryLocalDraftRepository implements LocalDraftRepository {
  record: LocalDraftRecord | null = null;
  clearAccountCalls = 0;

  get(): Promise<LocalDraftRecord | null> {
    return Promise.resolve(this.record);
  }

  put(record: LocalDraftRecord): Promise<void> {
    this.record = record;
    return Promise.resolve();
  }

  setPending(_scope: LocalDraftScope, envelope: PendingSaveEnvelope): Promise<void> {
    if (!this.record) return Promise.reject(new Error('缺少本地草稿'));
    this.record = { ...this.record, pendingEnvelope: envelope };
    return Promise.resolve();
  }

  discardPending(_scope: LocalDraftScope, idempotencyKey: string): Promise<boolean> {
    if (this.record?.pendingEnvelope?.idempotencyKey !== idempotencyKey) {
      return Promise.resolve(false);
    }
    this.record = { ...this.record, pendingEnvelope: null };
    return Promise.resolve(true);
  }

  acknowledgePending(_scope: LocalDraftScope, input: AcknowledgePendingInput): Promise<boolean> {
    if (this.record?.pendingEnvelope?.idempotencyKey !== input.idempotencyKey) {
      return Promise.resolve(false);
    }
    this.record = {
      ...this.record,
      baseRevision: input.revision,
      baseSnapshot: input.baseSnapshot,
      workingSnapshot: input.workingSnapshot,
      localSeq: input.localSeq,
      ackedSeq: input.clientSeq,
      pendingEnvelope: null,
    };
    return Promise.resolve(true);
  }

  exportAccountRescue(): Promise<string> {
    return Promise.resolve(JSON.stringify({ drafts: this.record ? [this.record] : [] }));
  }

  clearAccount(): Promise<number> {
    this.clearAccountCalls += 1;
    this.record = null;
    return Promise.resolve(1);
  }

  delete(): Promise<void> {
    this.record = null;
    return Promise.resolve();
  }

  close(): void {}
}

function deterministicIds() {
  let counter = 1;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function installAccountExitBrowserPrimitives() {
  class SilentBroadcastChannel {
    addEventListener(): void {}
    removeEventListener(): void {}
    postMessage(): void {}
    close(): void {}
  }
  vi.stubGlobal('BroadcastChannel', SilentBroadcastChannel);
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: {
      request: (
        _name: string,
        _options: unknown,
        callback: (lock: null) => unknown,
      ): Promise<unknown> => Promise.resolve(callback(null)),
    },
  });
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

function renamedReceipt(input: RenameResumeRequest) {
  return {
    resume: {
      id: input.resumeId,
      title: input.title,
      locale: 'zh-CN',
      stage: 'employed' as const,
      revision: String(Number(input.baseRevision) + 1),
      templateId: 'standard',
      templateVersion: '1.0.0',
      createdAt: '2026-09-18T08:00:00.000Z',
      updatedAt: '2026-09-18T08:00:01.000Z',
    },
    versionId: randomUUID(),
  };
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(navigator, 'locks');
  vi.unstubAllGlobals();
});

describe('editor workspace module management', () => {
  it('renames a clean resume and advances the shared revision without touching its body', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const body = store.getState().document;
    const rename = vi.fn<RenameTransport['rename']>((input) =>
      Promise.resolve(renamedReceipt(input)),
    );
    render(<EditorWorkspace initialResume={resume} renameTransport={{ rename }} store={store} />);

    await user.click(screen.getByTitle('重命名简历'));
    const dialog = screen.getByRole('dialog', { name: '重命名简历' });
    const input = within(dialog).getByRole('textbox', { name: '简历名称' });
    await user.clear(input);
    await user.type(input, '后端工程师简历🙂');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: '重命名简历' })).toBeNull();
    });
    expect(rename).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeId: resume.id,
        title: '后端工程师简历🙂',
        baseRevision: '1',
      }),
    );
    expect(screen.getByTitle('重命名简历').textContent).toContain('后端工程师简历🙂');
    expect(store.getState()).toMatchObject({ ackRevision: '2', isDirty: false });
    expect(store.getState().document).toBe(body);
  });

  it('reuses the same rename idempotency key after a lost response', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const rename = vi
      .fn<RenameTransport['rename']>()
      .mockRejectedValueOnce(new SaveTransportError('network', '连接已中断'))
      .mockImplementationOnce((input) => Promise.resolve(renamedReceipt(input)));
    render(<EditorWorkspace initialResume={resume} renameTransport={{ rename }} store={store} />);

    await user.click(screen.getByTitle('重命名简历'));
    const dialog = screen.getByRole('dialog', { name: '重命名简历' });
    const input = within(dialog).getByRole('textbox', { name: '简历名称' });
    await user.clear(input);
    await user.type(input, '丢失回执后的名称');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));
    await within(dialog).findByRole('alert');
    await user.click(within(dialog).getByRole('button', { name: '保存名称' }));

    await waitFor(() => {
      expect(rename).toHaveBeenCalledTimes(2);
    });
    expect(rename.mock.calls[0]?.[0].idempotencyKey).toBe(rename.mock.calls[1]?.[0].idempotencyKey);
    expect(store.getState().ackRevision).toBe('2');
  });

  it('moves modules from the keyboard, announces the result and preserves focus', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    await user.click(screen.getByRole('button', { name: '模块排序' }));
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
    await user.click(screen.getByRole('button', { name: '模块' }));
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

  it('creates an immediately editable custom module, labels copies and supports confirmed deletion', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);
    const { container } = render(<EditorWorkspace initialResume={resume} store={store} />);

    await user.click(screen.getByRole('button', { name: '模块' }));
    await user.type(screen.getByRole('textbox', { name: '新增自定义模块' }), '开源贡献');
    await user.click(screen.getByRole('button', { name: '新增自定义模块' }));

    const custom = sectionByKind(store.getState().document, 'custom');
    expect(custom.entries).toHaveLength(1);
    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '模块标题' }).value).toBe(
      '开源贡献',
    );
    const heading = screen.getByRole('textbox', { name: '主标题' });
    await user.type(heading, 'Codex CLI');
    expect(container.querySelector('.resume-page')?.textContent).toContain('Codex CLI');

    await user.click(screen.getByRole('button', { name: '复制条目' }));
    expect(sectionByKind(store.getState().document, 'custom').entries[1]?.heading).toBe(
      'Codex CLI 副本',
    );

    await user.click(screen.getByRole('button', { name: '模块' }));
    await user.click(screen.getByRole('button', { name: '删除开源贡献' }));
    expect(confirm).toHaveBeenCalledWith('确定删除“开源贡献”模块及其中内容吗？');
    expect(store.getState().document.sectionsById[custom.id]).toBeUndefined();
  });

  it('writes typography, design and page controls to the shared document and preview', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const { container } = render(<EditorWorkspace initialResume={resume} store={store} />);

    await user.click(screen.getByRole('button', { name: '排版' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '正文字号' }), {
      target: { value: '11.5' },
    });
    expect(store.getState().document.typography.bodyFontSizePt).toBe(11.5);

    await user.click(screen.getByRole('button', { name: '设计' }));
    fireEvent.change(screen.getByLabelText('标题色'), { target: { value: '#34495e' } });
    await user.click(screen.getByRole('switch', { name: '显示分隔线' }));
    expect(store.getState().document.design).toMatchObject({
      headingColor: '#34495e',
      divider: false,
    });

    await user.click(screen.getByRole('button', { name: '页面' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: '左边距' }), {
      target: { value: '18' },
    });
    await user.click(screen.getByRole('switch', { name: '显示页码' }));
    expect(store.getState().document.page).toMatchObject({
      marginMm: { left: 18 },
      showPageNumbers: true,
    });
    const renderer = container.querySelector<HTMLElement>('.resume-page')?.parentElement;
    expect(renderer?.style.getPropertyValue('--resume-body-size')).toBe('11.5pt');
    expect(renderer?.style.getPropertyValue('--resume-heading-color')).toBe('#34495e');
    expect(renderer?.style.getPropertyValue('--resume-divider-width')).toBe('0mm');
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
    await user.click(screen.getByRole('button', { name: '模块' }));
    const restore = screen.getByRole('button', { name: '恢复默认' });

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
    await user.click(screen.getByRole('button', { name: '收起设置面板' }));

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

  it('omits future feature entries while keeping real editor and rescue controls', async () => {
    const { resume, store } = createFixture();
    store.getState().hydrateWorkingCopy({
      document: resume.document,
      localSeq: 1,
      ackedSeq: 0,
      ackRevision: resume.revision,
    });
    const repository = new MemoryLocalDraftRepository();
    const scope = { userId: randomUUID(), resumeId: resume.id, tabId: randomUUID() };
    render(
      <EditorWorkspace
        initialResume={resume}
        localDraft={{
          repository,
          scope,
          initialRecord: null,
          initialError: new LocalDraftUnavailableError('quota'),
        }}
        store={store}
      />,
    );

    for (const name of ['分享', '导出 PDF', 'AI 优化', 'JD 匹配']) {
      expect(screen.queryAllByRole('button', { name })).toHaveLength(0);
    }
    expect(screen.queryByText('上传头像')).toBeNull();
    expect(screen.queryAllByLabelText(/更多操作/u)).toHaveLength(0);
    expect(screen.queryByText(/resume\.example/u)).toBeNull();
    expect(screen.queryByText(/本月剩余.*PDF/u)).toBeNull();
    for (const name of ['模板', '模块', '排版', '设计', '页面']) {
      expect(screen.getByRole('button', { name })).toBeInstanceOf(HTMLElement);
    }
    expect(screen.getByRole('textbox', { name: '姓名' })).toBeInstanceOf(HTMLElement);
    expect(screen.getByRole('region', { name: 'A4 简历预览' })).toBeInstanceOf(HTMLElement);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: '导出救援副本' })).toBeInstanceOf(HTMLElement);
    });
  });

  it('flushes on field blur and reports cloud ACK separately from local backup', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const repository = new MemoryLocalDraftRepository();
    const scope = { userId: randomUUID(), resumeId: resume.id, tabId: randomUUID() };
    const save = vi.fn<SaveTransport['save']>((envelope) =>
      Promise.resolve({
        resumeId: envelope.resumeId,
        revision: String(Number(envelope.baseRevision) + 1),
        versionId: randomUUID(),
        acknowledgedSeq: envelope.clientSeq,
        savedAt: '2026-09-18T08:00:00.000Z',
        contentHash: 'c'.repeat(64),
      }),
    );
    render(
      <EditorWorkspace
        initialResume={resume}
        localDraft={{ repository, scope, initialRecord: null }}
        saveTransport={{ save }}
        store={store}
      />,
    );
    await waitFor(() => {
      expect(repository.record).not.toBeNull();
    });
    const title = screen.getByRole('textbox', { name: '模块标题' });

    await user.click(title);
    await user.keyboard('{Control>}a{/Control}');
    await user.type(title, '基本资料');
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText('已保存')).toBeInstanceOf(HTMLElement);
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getState()).toMatchObject({ isDirty: false, ackRevision: '2' });
  });

  it('completes edit, preview, save and server-snapshot reload for a real resume field', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const repository = new MemoryLocalDraftRepository();
    const scope = { userId: randomUUID(), resumeId: resume.id, tabId: randomUUID() };
    const save = vi.fn<SaveTransport['save']>((envelope) => {
      return Promise.resolve({
        resumeId: envelope.resumeId,
        revision: '2',
        versionId: randomUUID(),
        acknowledgedSeq: envelope.clientSeq,
        savedAt: '2026-09-18T08:00:00.000Z',
        contentHash: 'e'.repeat(64),
      });
    });
    const firstRender = render(
      <EditorWorkspace
        initialResume={resume}
        localDraft={{ repository, scope, initialRecord: null }}
        saveTransport={{ save }}
        store={store}
      />,
    );
    await waitFor(() => {
      expect(repository.record).not.toBeNull();
    });

    const name = screen.getByRole('textbox', { name: '姓名' });
    await user.clear(name);
    await user.type(name, '林小满（已验证）');
    expect(firstRender.container.querySelector('.resume-page')?.textContent).toContain(
      '林小满（已验证）',
    );
    await user.tab();

    await waitFor(() => {
      expect(screen.getByText('已保存')).toBeInstanceOf(HTMLElement);
    });
    expect(save).toHaveBeenCalledTimes(1);
    const savedEnvelope = save.mock.calls[0]?.[0];
    if (!savedEnvelope) throw new Error('保存调用未产生服务器快照');
    const reloadedDocument: ResumeDocumentV1 = structuredClone(savedEnvelope.document);
    firstRender.unmount();

    const reloadedStore = createResumeEditorStore({ document: reloadedDocument, revision: '2' });
    const secondRender = render(
      <EditorWorkspace
        initialResume={{ ...resume, document: reloadedDocument, revision: '2' }}
        store={reloadedStore}
      />,
    );

    expect(screen.getByRole<HTMLInputElement>('textbox', { name: '姓名' }).value).toBe(
      '林小满（已验证）',
    );
    expect(secondRender.container.querySelector('.resume-page')?.textContent).toContain(
      '林小满（已验证）',
    );
    expect(reloadedStore.getState()).toMatchObject({ ackRevision: '2', isDirty: false });
  });

  it('keeps list-field focus while entering multiple values and commits them as one edit group', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    await user.click(screen.getByRole('button', { name: '求职意向' }));
    const industries = screen.getByRole<HTMLTextAreaElement>('textbox', { name: '目标行业' });

    await user.type(industries, '互联网,人工智能');

    expect(document.activeElement).toBe(industries);
    expect(sectionByKind(store.getState().document, 'intent').entries[0]?.industries).toEqual([
      '互联网',
      '人工智能',
    ]);
    await user.tab();
    expect(store.getState().undo()).toBe(true);
    expect(sectionByKind(store.getState().document, 'intent').entries[0]?.industries).toEqual([]);
  });

  it('keeps an active IME composition in the input until the complete value is committed', async () => {
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    const name = screen.getByRole<HTMLInputElement>('textbox', { name: '姓名' });

    fireEvent.compositionStart(name);
    fireEvent.change(name, { target: { value: '林小满中' } });
    await waitFor(() => {
      expect(name.value).toBe('林小满中');
    });
    fireEvent.change(name, { target: { value: '林小满中文' } });
    fireEvent.compositionEnd(name);

    expect(name.value).toBe('林小满中文');
    expect(sectionByKind(store.getState().document, 'basic').entries[0]?.name).toBe('林小满中文');
  });

  it('buffers an incomplete link and only commits a schema-valid URL on blur', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const project = sectionByKind(store.getState().document, 'project');
    const projectEntry = project.entries[0];
    if (!projectEntry) throw new Error('fixture 缺少项目条目');
    store
      .getState()
      .dispatch({ type: 'add-link', sectionId: project.id, entryId: projectEntry.id });
    render(<EditorWorkspace initialResume={resume} store={store} />);
    await user.click(screen.getByRole('button', { name: '项目经历' }));
    const url = screen.getByRole<HTMLInputElement>('textbox', { name: '链接地址' });

    await user.type(url, 'https://');
    await user.tab();

    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('完整地址');
    expect(sectionByKind(store.getState().document, 'project').entries[0]?.links[0]?.url).toBe('');

    await user.click(url);
    await user.type(url, 'example.com/resume');
    await user.tab();
    expect(sectionByKind(store.getState().document, 'project').entries[0]?.links[0]?.url).toBe(
      'https://example.com/resume',
    );
  });

  it('warns before leaving while edits are not acknowledged', () => {
    const { resume, store } = createFixture();
    render(<EditorWorkspace initialResume={resume} store={store} />);
    const sectionId = store.getState().document.moduleOrder[1];
    if (!sectionId) throw new Error('fixture 缺少可编辑模块');
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '未确认修改' });

    const event = new Event('beforeunload', { cancelable: true });
    expect(window.dispatchEvent(event)).toBe(false);
    expect(event.defaultPrevented).toBe(true);
  });

  it('shows the prototype save-failure notice and allows deferring a retry', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const repository = new MemoryLocalDraftRepository();
    const scope = { userId: randomUUID(), resumeId: resume.id, tabId: randomUUID() };
    const save = vi
      .fn<SaveTransport['save']>()
      .mockRejectedValue(new SaveTransportError('fatal', '模拟保存失败'));
    render(
      <EditorWorkspace
        initialResume={resume}
        localDraft={{ repository, scope, initialRecord: null }}
        saveTransport={{ save }}
        store={store}
      />,
    );
    await waitFor(() => {
      expect(repository.record).not.toBeNull();
    });
    const title = screen.getByRole('textbox', { name: '模块标题' });
    fireEvent.change(title, { target: { value: '触发失败通知' } });
    fireEvent.blur(title);

    const notice = await screen.findByRole('alert', { name: '保存状态通知' });
    expect(within(notice).getByText('无法保存最新修改')).toBeInstanceOf(HTMLElement);
    expect(within(notice).getByText(/暂时保存在本地/)).toBeInstanceOf(HTMLElement);
    await user.click(within(notice).getByRole('button', { name: '稍后重试' }));
    expect(screen.queryByRole('alert', { name: '保存状态通知' })).toBeNull();
  });

  it('freezes uploads on 401 and offers same-account login plus rescue when IndexedDB failed', async () => {
    const { resume, store } = createFixture();
    const repository = new MemoryLocalDraftRepository();
    const scope = { userId: randomUUID(), resumeId: resume.id, tabId: randomUUID() };
    const save = vi
      .fn<SaveTransport['save']>()
      .mockRejectedValue(new SaveTransportError('auth', '登录状态已失效', { status: 401 }));
    render(
      <EditorWorkspace
        initialResume={resume}
        localDraft={{
          repository,
          scope,
          initialRecord: null,
          initialError: new LocalDraftUnavailableError('unavailable'),
        }}
        saveTransport={{ save }}
        store={store}
      />,
    );
    const title = screen.getByRole('textbox', { name: '模块标题' });
    fireEvent.change(title, { target: { value: '会话过期时的本地修改' } });
    fireEvent.blur(title);

    const notice = await screen.findByRole('alert', { name: '登录状态通知' });
    expect(within(notice).getByText(/已停止上传/u)).toBeInstanceOf(HTMLElement);
    expect(within(notice).getByRole('button', { name: '导出救援副本' })).toBeInstanceOf(
      HTMLElement,
    );
    expect(within(notice).getByRole('link', { name: '重新登录' }).getAttribute('href')).toBe(
      `/login?returnTo=${encodeURIComponent(`/resumes/${resume.id}/edit`)}`,
    );
    expect(save).toHaveBeenCalledTimes(1);
    expect(store.getState().isDirty).toBe(true);
    expect(screen.queryByText('已保存', { exact: true })).toBeNull();
  });

  it('keeps the account draft and reports an incomplete exit when sign-out is offline', async () => {
    installAccountExitBrowserPrimitives();
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const repository = new MemoryLocalDraftRepository();
    const userId = randomUUID();
    const scope = { userId, resumeId: resume.id, tabId: randomUUID() };
    const fetchMock = vi.fn(() => Promise.reject(new TypeError('offline')));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <EditorWorkspace
        accountUserId={userId}
        canSignOut
        initialResume={resume}
        localDraft={{ repository, scope, initialRecord: null }}
        saveTransport={{ save: vi.fn() }}
        store={store}
      />,
    );
    await waitFor(() => {
      expect(repository.record).not.toBeNull();
    });

    await user.click(screen.getByRole('button', { name: '退出' }));

    expect(await screen.findByRole('heading', { name: '尚未完成退出' })).toBeInstanceOf(
      HTMLElement,
    );
    expect(screen.getByText(/草稿仍被保留/u)).toBeInstanceOf(HTMLElement);
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/sign-out', expect.any(Object));
    expect(repository.clearAccountCalls).toBe(0);
    expect(repository.record).not.toBeNull();
  });

  it('shows a three-way conflict overlay and explicitly rebases the full local snapshot', async () => {
    const user = userEvent.setup();
    const { resume, store } = createFixture();
    const repository = new MemoryLocalDraftRepository();
    const scope = { userId: randomUUID(), resumeId: resume.id, tabId: randomUUID() };
    const remoteDocument = structuredClone(resume.document);
    const remoteSectionId = remoteDocument.moduleOrder[0];
    if (!remoteSectionId) throw new Error('fixture 缺少远端模块');
    const remoteSection = remoteDocument.sectionsById[remoteSectionId];
    if (!remoteSection) throw new Error('fixture 缺少远端模块映射');
    remoteSection.title = '服务器版本标题';
    const conflictSnapshotTransport: ConflictSnapshotTransport = {
      loadCurrent: vi.fn(() => {
        return Promise.resolve({ resumeId: resume.id, document: remoteDocument, revision: '2' });
      }),
    };
    const save = vi
      .fn<SaveTransport['save']>()
      .mockRejectedValueOnce(
        new SaveTransportError('conflict', '版本冲突', { currentRevision: '2' }),
      )
      .mockImplementationOnce((envelope) =>
        Promise.resolve({
          resumeId: envelope.resumeId,
          revision: '3',
          versionId: randomUUID(),
          acknowledgedSeq: envelope.clientSeq,
          savedAt: '2026-09-18T08:00:00.000Z',
          contentHash: 'd'.repeat(64),
        }),
      );
    render(
      <EditorWorkspace
        conflictSnapshotTransport={conflictSnapshotTransport}
        initialResume={resume}
        localDraft={{ repository, scope, initialRecord: null }}
        saveTransport={{ save }}
        store={store}
      />,
    );
    await waitFor(() => {
      expect(repository.record).not.toBeNull();
    });
    const title = screen.getByRole('textbox', { name: '模块标题' });
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: '本地版本标题' } });
    fireEvent.blur(title);

    const dialog = await screen.findByRole('dialog', { name: '检测到服务器版本冲突' });
    expect(within(dialog).getByText(/基于版本 1/)).toBeInstanceOf(HTMLElement);
    expect(within(dialog).getByText('双方修改不同')).toBeInstanceOf(HTMLElement);
    await user.click(within(dialog).getByRole('button', { name: '以服务器为基线重试本地修改' }));

    await waitFor(() => {
      expect(screen.getByText('已保存')).toBeInstanceOf(HTMLElement);
    });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[0]).toMatchObject({ baseRevision: '2' });
    expect(store.getState().document.sectionsById[remoteSectionId]?.title).toBe('本地版本标题');
  });
});
