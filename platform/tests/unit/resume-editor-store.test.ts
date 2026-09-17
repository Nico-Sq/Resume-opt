import { describe, expect, it, vi } from 'vitest';

import { createInitialResumeDocument, type ContentSection } from '@resume/domain/resume';
import {
  createEntryFieldEditSession,
  handleResumeHistoryShortcut,
} from '../../apps/web/src/client/editor/store/field-edit-session';
import {
  createResumeEditorStore,
  selectResumeSection,
} from '../../apps/web/src/client/editor/store/resume-editor-store';

function deterministicIds(start = 1) {
  let counter = start;
  return () => `00000000-0000-4000-8000-${String(counter++).padStart(12, '0')}`;
}

function createDocument() {
  return createInitialResumeDocument(deterministicIds());
}

function sectionByKind<K extends ContentSection['kind']>(
  document: ReturnType<typeof createDocument>,
  kind: K,
): Extract<ContentSection, { kind: K }> {
  const sectionValue = Object.values(document.sectionsById).find(
    (candidate): candidate is Extract<ContentSection, { kind: K }> => candidate.kind === kind,
  );
  if (!sectionValue) throw new Error(`fixture 缺少 ${kind} 模块`);
  return sectionValue;
}

function basicNameTarget(document: ReturnType<typeof createDocument>) {
  const basic = sectionByKind(document, 'basic');
  const entry = basic.entries[0];
  if (!entry) throw new Error('fixture 缺少基本信息条目');
  return { sectionId: basic.id, entryId: entry.id, path: ['name'] as const };
}

function readBasicName(store: ReturnType<typeof createResumeEditorStore>) {
  return sectionByKind(store.getState().document, 'basic').entries[0]?.name;
}

describe('resume editor store', () => {
  it('keeps one authoritative document and notifies only changed section selectors', () => {
    const document = createDocument();
    const store = createResumeEditorStore({ document, revision: '1' });
    const basicId = sectionByKind(store.getState().document, 'basic').id;
    const educationId = sectionByKind(store.getState().document, 'education').id;
    const basicBefore = store.getState().document.sectionsById[basicId];
    const educationBefore = store.getState().document.sectionsById[educationId];
    const basicListener = vi.fn();
    const educationListener = vi.fn();
    const unsubscribeBasic = store.subscribe(selectResumeSection(basicId), basicListener);
    const unsubscribeEducation = store.subscribe(
      selectResumeSection(educationId),
      educationListener,
    );

    store.getState().dispatch({
      type: 'set-entry-field',
      ...basicNameTarget(store.getState().document),
      value: '张三',
    });

    expect(store.getState().document.sectionsById[basicId]).not.toBe(basicBefore);
    expect(store.getState().document.sectionsById[educationId]).toBe(educationBefore);
    expect(basicListener).toHaveBeenCalledOnce();
    expect(educationListener).not.toHaveBeenCalled();
    expect(store.getState()).toMatchObject({ localSeq: 1, ackedSeq: 0, isDirty: true });
    unsubscribeBasic();
    unsubscribeEducation();
  });

  it('groups a typing transaction into one undo step and clears redo on new edits', () => {
    const store = createResumeEditorStore({ document: createDocument(), revision: '1' });
    const session = createEntryFieldEditSession(store, basicNameTarget(store.getState().document));

    session.change('张');
    session.change('张三');
    session.blur();
    expect(readBasicName(store)).toBe('张三');
    expect(store.getState()).toMatchObject({ localSeq: 2, canUndo: true, canRedo: false });

    expect(store.getState().undo()).toBe(true);
    expect(readBasicName(store)).toBe('');
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: true });

    expect(store.getState().redo()).toBe(true);
    expect(readBasicName(store)).toBe('张三');
    expect(store.getState().undo()).toBe(true);
    session.change('李四');
    session.blur();
    expect(store.getState().canRedo).toBe(false);
  });

  it('holds IME composition in the active field and commits it as one history group', () => {
    const store = createResumeEditorStore({ document: createDocument(), revision: '1' });
    const session = createEntryFieldEditSession(store, basicNameTarget(store.getState().document));

    session.compositionStart();
    session.compositionUpdate('n');
    session.compositionUpdate('ni');
    expect(readBasicName(store)).toBe('');
    expect(store.getState().localSeq).toBe(0);

    session.compositionEnd('你');
    expect(readBasicName(store)).toBe('你');
    expect(store.getState().localSeq).toBe(1);
    expect(store.getState().undo()).toBe(true);
    expect(readBasicName(store)).toBe('');
  });

  it('routes Ctrl/Cmd history shortcuts to one document history implementation', () => {
    const store = createResumeEditorStore({ document: createDocument(), revision: '1' });
    store.getState().dispatch({
      type: 'set-entry-field',
      ...basicNameTarget(store.getState().document),
      value: '张三',
    });
    const preventDefault = vi.fn();

    expect(
      handleResumeHistoryShortcut(store, {
        key: 'z',
        defaultPrevented: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: false,
        preventDefault,
      }),
    ).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(readBasicName(store)).toBe('');

    expect(
      handleResumeHistoryShortcut(store, {
        key: 'z',
        defaultPrevented: false,
        ctrlKey: true,
        metaKey: false,
        shiftKey: false,
        altKey: false,
        isComposing: true,
        preventDefault,
      }),
    ).toBe(false);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('accepts an old ACK without overwriting newer input and ignores regressing ACKs', () => {
    const store = createResumeEditorStore({ document: createDocument(), revision: '1' });
    const target = basicNameTarget(store.getState().document);
    store.getState().dispatch({ type: 'set-entry-field', ...target, value: '张' });
    store.getState().dispatch({ type: 'set-entry-field', ...target, value: '张三' });

    expect(store.getState().acknowledge({ clientSeq: 1, revision: '2' })).toBe(true);
    expect(readBasicName(store)).toBe('张三');
    expect(store.getState()).toMatchObject({
      localSeq: 2,
      ackedSeq: 1,
      ackRevision: '2',
      isDirty: true,
    });
    expect(store.getState().acknowledge({ clientSeq: 0, revision: '1' })).toBe(false);
    expect(store.getState().acknowledge({ clientSeq: 2, revision: '3' })).toBe(true);
    expect(store.getState().acknowledge({ clientSeq: 2, revision: '2' })).toBe(false);
    expect(store.getState().ackRevision).toBe('3');
    expect(store.getState().isDirty).toBe(false);
  });

  it('hydrates a recovered working copy and resets session history', () => {
    const store = createResumeEditorStore({ document: createDocument(), revision: '1' });
    const recovered = createDocument();
    const target = basicNameTarget(recovered);
    const recoveryStore = createResumeEditorStore({ document: recovered, revision: '4' });
    recoveryStore.getState().dispatch({ type: 'set-entry-field', ...target, value: '恢复的草稿' });

    store.getState().dispatch({
      type: 'set-entry-field',
      ...basicNameTarget(store.getState().document),
      value: '旧会话',
    });
    store.getState().hydrateWorkingCopy({
      document: recoveryStore.getState().document,
      localSeq: 8,
      ackedSeq: 6,
      ackRevision: '4',
    });

    expect(readBasicName(store)).toBe('恢复的草稿');
    expect(store.getState()).toMatchObject({
      localSeq: 8,
      ackedSeq: 6,
      ackRevision: '4',
      isDirty: true,
      canUndo: false,
      canRedo: false,
    });
    expect(store.getState().undo()).toBe(false);
  });

  it('replaces from a remote revision and starts a fresh local session', () => {
    const store = createResumeEditorStore({ document: createDocument(), revision: '1' });
    store.getState().dispatch({
      type: 'set-entry-field',
      ...basicNameTarget(store.getState().document),
      value: '本地修改',
    });
    const remote = createDocument();

    store.getState().replaceFromRemote({ document: remote, revision: '9' });

    expect(store.getState()).toMatchObject({
      localSeq: 0,
      ackedSeq: 0,
      ackRevision: '9',
      isDirty: false,
      canUndo: false,
      canRedo: false,
    });
    expect(readBasicName(store)).toBe('');
  });
});
