import {
  applyResumeEditCommand,
  ResumeDocumentV1Schema,
  type IdFactory,
  type ResumeDocumentV1,
  type ResumeEditCommand,
} from '@resume/domain/resume';
import { applyPatches, enablePatches, produceWithPatches, type Patch } from 'immer';
import { subscribeWithSelector } from 'zustand/middleware';
import { createStore } from 'zustand/vanilla';

enablePatches();

interface HistoryEntry {
  forward: Patch[];
  inverse: Patch[];
  groupSerial: number | null;
}

interface ActiveHistoryGroup {
  id: string;
  serial: number;
}

export interface ResumeEditorSnapshot {
  document: ResumeDocumentV1;
  localSeq: number;
  ackedSeq: number;
  ackRevision: string;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

export interface ResumeEditorActions {
  dispatch: (command: ResumeEditCommand, options?: { idFactory?: IdFactory }) => boolean;
  beginHistoryGroup: (id: string) => void;
  endHistoryGroup: (id?: string) => void;
  undo: () => boolean;
  redo: () => boolean;
  acknowledge: (receipt: { clientSeq: number; revision: string }) => boolean;
  hydrateWorkingCopy: (snapshot: {
    document: ResumeDocumentV1;
    localSeq: number;
    ackedSeq: number;
    ackRevision: string;
  }) => void;
  replaceFromRemote: (snapshot: { document: ResumeDocumentV1; revision: string }) => void;
}

export type ResumeEditorState = ResumeEditorSnapshot & ResumeEditorActions;

export interface CreateResumeEditorStoreOptions {
  document: ResumeDocumentV1;
  revision: string;
  historyLimit?: number;
}

function shareUnchangedStructure<T>(current: T, next: T): T {
  if (Object.is(current, next)) return current;
  if (Array.isArray(current) && Array.isArray(next)) {
    const currentItems = current as unknown[];
    const nextItems = next as unknown[];
    if (currentItems.length !== nextItems.length) return next;
    const shared = nextItems.map((item, index) =>
      shareUnchangedStructure(currentItems[index], item),
    );
    return shared.every((item, index) => Object.is(item, currentItems[index]))
      ? current
      : (shared as T);
  }
  if (
    current !== null &&
    next !== null &&
    typeof current === 'object' &&
    typeof next === 'object'
  ) {
    const currentRecord = current as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const currentKeys = Object.keys(currentRecord);
    const nextKeys = Object.keys(nextRecord);
    if (
      currentKeys.length !== nextKeys.length ||
      currentKeys.some((key) => !Object.prototype.hasOwnProperty.call(nextRecord, key))
    ) {
      return next;
    }
    const sharedEntries = nextKeys.map(
      (key) => [key, shareUnchangedStructure(currentRecord[key], nextRecord[key])] as const,
    );
    return sharedEntries.every(([key, value]) => Object.is(value, currentRecord[key]))
      ? current
      : (Object.fromEntries(sharedEntries) as T);
  }
  return next;
}

function parseSnapshot(document: ResumeDocumentV1): ResumeDocumentV1 {
  return ResumeDocumentV1Schema.parse(document);
}

function assertSequence(localSeq: number, ackedSeq: number): void {
  if (
    !Number.isSafeInteger(localSeq) ||
    !Number.isSafeInteger(ackedSeq) ||
    localSeq < 0 ||
    ackedSeq < 0 ||
    ackedSeq > localSeq
  ) {
    throw new Error('编辑序号必须为非负安全整数，且 ackedSeq 不能超过 localSeq');
  }
}

export function createResumeEditorStore(options: CreateResumeEditorStoreOptions) {
  const historyLimit = options.historyLimit ?? 100;
  if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) {
    throw new Error('historyLimit 必须是正安全整数');
  }

  let past: HistoryEntry[] = [];
  let future: HistoryEntry[] = [];
  let activeGroup: ActiveHistoryGroup | null = null;
  let nextGroupSerial = 1;

  const setHistoryFlags = () => ({ canUndo: past.length > 0, canRedo: future.length > 0 });
  const closeGroup = () => {
    activeGroup = null;
  };
  const clearHistory = () => {
    past = [];
    future = [];
    closeGroup();
  };

  return createStore<ResumeEditorState>()(
    subscribeWithSelector((set, get) => ({
      document: parseSnapshot(options.document),
      localSeq: 0,
      ackedSeq: 0,
      ackRevision: options.revision,
      isDirty: false,
      canUndo: false,
      canRedo: false,
      dispatch: (command, commandOptions = {}) => {
        const state = get();
        const candidate = applyResumeEditCommand(state.document, command, commandOptions);
        const shared = shareUnchangedStructure(state.document, candidate);
        const [nextDocument, forward, inverse] = produceWithPatches(state.document, () => shared);
        if (forward.length === 0) return false;

        const groupSerial = activeGroup?.serial ?? null;
        const previous = past.at(-1);
        if (groupSerial !== null && previous?.groupSerial === groupSerial) {
          previous.forward = forward;
        } else {
          past.push({ forward, inverse, groupSerial });
          if (past.length > historyLimit) past.shift();
        }
        future = [];
        const localSeq = state.localSeq + 1;
        set({
          document: nextDocument,
          localSeq,
          isDirty: localSeq > state.ackedSeq,
          ...setHistoryFlags(),
        });
        return true;
      },
      beginHistoryGroup: (id) => {
        if (id.length === 0) throw new Error('历史分组 ID 不能为空');
        if (activeGroup?.id === id) return;
        activeGroup = { id, serial: nextGroupSerial };
        nextGroupSerial += 1;
      },
      endHistoryGroup: (id) => {
        if (id !== undefined && activeGroup?.id !== id) return;
        closeGroup();
      },
      undo: () => {
        closeGroup();
        const entry = past.pop();
        if (!entry) return false;
        const state = get();
        future.push(entry);
        const localSeq = state.localSeq + 1;
        set({
          document: applyPatches(state.document, entry.inverse),
          localSeq,
          isDirty: localSeq > state.ackedSeq,
          ...setHistoryFlags(),
        });
        return true;
      },
      redo: () => {
        closeGroup();
        const entry = future.pop();
        if (!entry) return false;
        const state = get();
        past.push(entry);
        const localSeq = state.localSeq + 1;
        set({
          document: applyPatches(state.document, entry.forward),
          localSeq,
          isDirty: localSeq > state.ackedSeq,
          ...setHistoryFlags(),
        });
        return true;
      },
      acknowledge: ({ clientSeq, revision }) => {
        const state = get();
        if (
          !/^[1-9]\d*$/u.test(revision) ||
          !Number.isSafeInteger(clientSeq) ||
          clientSeq < state.ackedSeq ||
          clientSeq > state.localSeq
        ) {
          return false;
        }
        if (clientSeq === state.ackedSeq) return revision === state.ackRevision;
        set({
          ackedSeq: clientSeq,
          ackRevision: revision,
          isDirty: state.localSeq > clientSeq,
        });
        return true;
      },
      hydrateWorkingCopy: (snapshot) => {
        assertSequence(snapshot.localSeq, snapshot.ackedSeq);
        clearHistory();
        set({
          document: parseSnapshot(snapshot.document),
          localSeq: snapshot.localSeq,
          ackedSeq: snapshot.ackedSeq,
          ackRevision: snapshot.ackRevision,
          isDirty: snapshot.localSeq > snapshot.ackedSeq,
          ...setHistoryFlags(),
        });
      },
      replaceFromRemote: (snapshot) => {
        clearHistory();
        set({
          document: parseSnapshot(snapshot.document),
          localSeq: 0,
          ackedSeq: 0,
          ackRevision: snapshot.revision,
          isDirty: false,
          ...setHistoryFlags(),
        });
      },
    })),
  );
}

export type ResumeEditorStore = ReturnType<typeof createResumeEditorStore>;

export function selectResumeSection(sectionId: string) {
  return (state: ResumeEditorState) => state.document.sectionsById[sectionId];
}

export const selectResumeSaveState = (state: ResumeEditorState) => ({
  localSeq: state.localSeq,
  ackedSeq: state.ackedSeq,
  ackRevision: state.ackRevision,
  isDirty: state.isDirty,
});
