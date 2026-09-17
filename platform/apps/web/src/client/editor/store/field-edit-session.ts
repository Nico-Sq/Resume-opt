import type { EditablePrimitive } from '@resume/domain/resume';

import type { ResumeEditorStore } from './resume-editor-store';

export interface EntryFieldTarget {
  sectionId: string;
  entryId: string;
  path: ReadonlyArray<string | number>;
}

export interface EntryFieldEditSession {
  change: (value: EditablePrimitive) => void;
  compositionStart: () => void;
  compositionUpdate: (value: EditablePrimitive) => void;
  compositionEnd: (value: EditablePrimitive) => void;
  blur: () => void;
  cancel: () => void;
  isComposing: () => boolean;
}

let nextSessionId = 1;

export function createEntryFieldEditSession(
  store: ResumeEditorStore,
  target: EntryFieldTarget,
): EntryFieldEditSession {
  const sessionId = nextSessionId;
  nextSessionId += 1;
  const typingGroupId = `field:${String(sessionId)}:typing`;
  const compositionGroupId = `field:${String(sessionId)}:composition`;
  let typingStarted = false;
  let composing = false;
  let pendingComposition: EditablePrimitive | undefined;

  const endTyping = () => {
    if (!typingStarted) return;
    store.getState().endHistoryGroup(typingGroupId);
    typingStarted = false;
  };
  const dispatch = (value: EditablePrimitive) => {
    store.getState().dispatch({ type: 'set-entry-field', ...target, value });
  };

  return {
    change: (value) => {
      if (composing) {
        pendingComposition = value;
        return;
      }
      if (!typingStarted) {
        store.getState().beginHistoryGroup(typingGroupId);
        typingStarted = true;
      }
      dispatch(value);
    },
    compositionStart: () => {
      endTyping();
      composing = true;
      pendingComposition = undefined;
      store.getState().beginHistoryGroup(compositionGroupId);
    },
    compositionUpdate: (value) => {
      if (composing) pendingComposition = value;
    },
    compositionEnd: (value) => {
      if (!composing) return;
      pendingComposition = value;
      dispatch(pendingComposition);
      composing = false;
      pendingComposition = undefined;
      store.getState().endHistoryGroup(compositionGroupId);
    },
    blur: () => {
      if (composing && pendingComposition !== undefined) dispatch(pendingComposition);
      if (composing) store.getState().endHistoryGroup(compositionGroupId);
      composing = false;
      pendingComposition = undefined;
      endTyping();
    },
    cancel: () => {
      if (composing) store.getState().endHistoryGroup(compositionGroupId);
      composing = false;
      pendingComposition = undefined;
      endTyping();
    },
    isComposing: () => composing,
  };
}

export interface HistoryShortcutEvent {
  key: string;
  defaultPrevented: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  isComposing: boolean;
  preventDefault: () => void;
}

export function handleResumeHistoryShortcut(
  store: ResumeEditorStore,
  event: HistoryShortcutEvent,
): boolean {
  if (event.defaultPrevented) return false;
  if (event.isComposing || event.altKey || (!event.ctrlKey && !event.metaKey)) return false;
  const key = event.key.toLowerCase();
  const isUndo = key === 'z' && !event.shiftKey;
  const isRedo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey);
  if (!isUndo && !isRedo) return false;

  event.preventDefault();
  return isRedo ? store.getState().redo() : store.getState().undo();
}
