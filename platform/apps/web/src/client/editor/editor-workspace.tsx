'use client';

import { type ContentSection, type ResumeDocumentV1 } from '@resume/domain/resume';
import {
  ATS_BASIC_TEMPLATE_MANIFEST,
  computePreviewScale,
  createRenderFlow,
  createResumeRenderModel,
  DEFAULT_FONT_MANIFEST,
  getA4PageMetrics,
  paginateRenderFlow,
  RENDER_POLICY_V1,
  ResumeMeasurementSurface,
  ResumePages,
  type RenderBlockMeasurement,
  type RenderFlowBlock,
} from '@resume/resume-renderer';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

import { AccountExitBarrier } from '../account/account-exit-barrier';
import { subscribeToResumeDeleted } from '../resume-lifecycle-channel';
import {
  createResumeEditorStore,
  ResumeEditorStoreProvider,
  useResumeEditorStore,
  type ResumeEditorStore,
} from './store';
import {
  hasUnsyncedLocalChanges,
  LocalDraftController,
  type LocalDraftRecord,
  type LocalDraftRepository,
  type LocalDraftScope,
  type LocalDraftStatus,
  type LocalDraftUnavailableError,
} from './persistence';
import {
  HttpSaveTransport,
  HttpRenameTransport,
  SaveTransportError,
  SaveCoordinator,
  type RenameTransport,
  type SaveCoordinatorStatus,
  type SaveTransport,
} from './saving';
import {
  ConflictDialog,
  ConflictSnapshotError,
  HttpConflictSnapshotTransport,
  type ConflictSnapshotTransport,
} from './conflict';
import { SectionFieldsEditor } from './section-fields-editor';
import { EditorIcon, type EditorIconName } from './editor-icons';
import styles from './editor-workspace.module.css';

export interface EditorResume {
  id: string;
  title: string;
  document: ResumeDocumentV1;
  revision: string;
}

export interface EditorWorkspaceProps {
  accountUserId?: string | undefined;
  canSignOut?: boolean | undefined;
  initialResume: EditorResume;
  store?: ResumeEditorStore;
  localDraft?: EditorLocalDraftContext;
  saveTransport?: SaveTransport;
  renameTransport?: RenameTransport;
  conflictSnapshotTransport?: ConflictSnapshotTransport;
}

export interface EditorLocalDraftContext {
  repository: LocalDraftRepository;
  scope: LocalDraftScope;
  initialRecord: LocalDraftRecord | null;
  initialError?: LocalDraftUnavailableError;
}

type ConflictViewState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'ready';
      context: NonNullable<ReturnType<SaveCoordinator['getConflictContext']>>;
      remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>;
    };

type AccountExitState =
  | { status: 'idle' }
  | { status: 'preparing' }
  | { status: 'decision'; unsyncedCount: number; confirmDiscard: boolean }
  | { status: 'error'; message: string };

const repeatableKinds = new Set<ContentSection['kind']>([
  'education',
  'work',
  'project',
  'internship',
  'campus',
  'skillsCertificates',
  'awards',
  'custom',
]);

const moduleGlyph: Record<ContentSection['kind'], EditorIconName> = {
  basic: 'basic',
  intent: 'intent',
  summary: 'summary',
  education: 'education',
  work: 'work',
  project: 'project',
  internship: 'internship',
  campus: 'campus',
  skillsCertificates: 'skills',
  awards: 'award',
  selfEvaluation: 'self-evaluation',
  custom: 'summary',
};

type RightPanelMode = 'style' | 'modules' | 'sorting';

function estimateBlockHeight(block: RenderFlowBlock): number {
  switch (block.kind) {
    case 'header':
      return 72;
    case 'section-heading':
      return 34;
    case 'entry-heading':
      return 38;
    case 'paragraph':
    case 'bullet':
      return Math.max(24, Math.ceil(block.text.length / 42) * 24);
    case 'links':
      return 24;
  }
}

function estimatedMeasurements(flow: readonly RenderFlowBlock[]) {
  return Object.fromEntries(
    flow.map((block) => [block.key, { heightPx: estimateBlockHeight(block) }]),
  ) as Record<string, RenderBlockMeasurement>;
}

function numericStyle(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measureElementHeight(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return (
    element.getBoundingClientRect().height +
    numericStyle(style.marginTop) +
    numericStyle(style.marginBottom)
  );
}

function measureWrappedText(
  element: HTMLElement,
  text: string,
): Array<{ text: string; heightPx: number }> | undefined {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let textNode: Text | null = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.textContent === text) {
      textNode = node as Text;
      break;
    }
  }
  if (!textNode || text.length === 0) return undefined;

  const offsets = [0];
  for (const character of text) offsets.push((offsets.at(-1) ?? 0) + character.length);
  const style = getComputedStyle(element);
  const lineHeight = numericStyle(style.lineHeight);
  const fragments: Array<{ text: string; heightPx: number }> = [];
  const range = document.createRange();
  let startIndex = 0;

  while (startIndex < offsets.length - 1) {
    let low = startIndex + 1;
    let high = offsets.length - 1;
    let lineEndIndex = low;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      range.setStart(textNode, offsets[startIndex] ?? 0);
      range.setEnd(textNode, offsets[middle] ?? text.length);
      const rectangles = [...range.getClientRects()].filter(
        (rectangle) => rectangle.width > 0 || rectangle.height > 0,
      );
      if (rectangles.length <= 1) {
        lineEndIndex = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }

    range.setStart(textNode, offsets[startIndex] ?? 0);
    range.setEnd(textNode, offsets[lineEndIndex] ?? text.length);
    const measuredLineHeight = Math.max(
      lineHeight,
      ...[...range.getClientRects()].map((rectangle) => rectangle.height),
    );
    fragments.push({
      text: text.slice(offsets[startIndex], offsets[lineEndIndex]),
      heightPx: measuredLineHeight,
    });
    startIndex = lineEndIndex;
  }

  const first = fragments[0];
  const last = fragments.at(-1);
  if (first) first.heightPx += numericStyle(style.marginTop);
  if (last) last.heightPx += numericStyle(style.marginBottom);
  return fragments;
}

function scheduleNextFrame(callback: () => void): void {
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(callback);
  else setTimeout(callback, 0);
}

function focusOnNextFrame(target: () => HTMLElement | null | undefined): void {
  scheduleNextFrame(() => target()?.focus());
}

function classNames(...values: Array<string | false | undefined>): string {
  return values.filter((value): value is string => typeof value === 'string').join(' ');
}

function downloadJson(content: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function EditorWorkspace({
  accountUserId,
  canSignOut = false,
  initialResume,
  store: providedStore,
  localDraft,
  saveTransport,
  renameTransport,
  conflictSnapshotTransport,
}: EditorWorkspaceProps) {
  const [store] = useState(() => {
    const editorStore =
      providedStore ??
      createResumeEditorStore({
        document: initialResume.document,
        revision: initialResume.revision,
      });
    if (localDraft?.initialRecord && hasUnsyncedLocalChanges(localDraft.initialRecord)) {
      editorStore.getState().hydrateWorkingCopy({
        document: localDraft.initialRecord.workingSnapshot,
        localSeq: localDraft.initialRecord.localSeq,
        ackedSeq: localDraft.initialRecord.ackedSeq,
        ackRevision: localDraft.initialRecord.baseRevision,
      });
    }
    return editorStore;
  });
  const [localDraftStatus, setLocalDraftStatus] = useState<LocalDraftStatus | null>(
    localDraft ? { phase: 'initializing' } : null,
  );
  const [cloudSaveStatus, setCloudSaveStatus] = useState<SaveCoordinatorStatus | null>(() =>
    localDraft
      ? store.getState().isDirty
        ? { phase: 'dirty' }
        : { phase: 'synced', revision: store.getState().ackRevision }
      : null,
  );
  const [resumeTitle, setResumeTitle] = useState(initialResume.title);
  const [resolvedRenameTransport] = useState(() => renameTransport ?? new HttpRenameTransport());
  const localDraftControllerRef = useRef<LocalDraftController | null>(null);
  const saveCoordinatorRef = useRef<SaveCoordinator | null>(null);
  const accountBarrierRef = useRef<AccountExitBarrier | null>(null);
  const accountLockedRef = useRef(false);
  const resourceUnavailableRef = useRef(false);
  const [accountLocked, setAccountLocked] = useState(false);
  const [accountExit, setAccountExit] = useState<AccountExitState>({ status: 'idle' });
  const [resolvedConflictTransport] = useState(
    () => conflictSnapshotTransport ?? new HttpConflictSnapshotTransport(),
  );
  const [conflictView, setConflictView] = useState<ConflictViewState>({ status: 'idle' });
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictLoadAttempt, setConflictLoadAttempt] = useState(0);

  const prepareAccountExit = useCallback(async () => {
    if (accountLockedRef.current) return;
    accountLockedRef.current = true;
    setAccountLocked(true);
    setAccountExit((state) => (state.status === 'idle' ? { status: 'preparing' } : state));
    saveCoordinatorRef.current?.dispose();
    saveCoordinatorRef.current = null;
    const controller = localDraftControllerRef.current;
    localDraftControllerRef.current = null;
    await controller?.dispose();
  }, []);

  useEffect(() => {
    if (!localDraft) return;
    const controller = new LocalDraftController({
      repository: localDraft.repository,
      scope: localDraft.scope,
      store,
      remoteDocument: initialResume.document,
      remoteRevision: initialResume.revision,
      initialRecord: localDraft.initialRecord,
      ...(localDraft.initialError ? { initialError: localDraft.initialError } : {}),
      onStatus: setLocalDraftStatus,
    });
    localDraftControllerRef.current = controller;
    let disposed = false;
    void controller.start().then(async () => {
      if (disposed || accountLockedRef.current) {
        await controller.dispose();
        return;
      }
      const saveCoordinator = new SaveCoordinator({
        resumeId: initialResume.id,
        store,
        persistence: controller,
        transport: saveTransport ?? new HttpSaveTransport(),
        onStatus: setCloudSaveStatus,
      });
      saveCoordinatorRef.current = saveCoordinator;
      if (resourceUnavailableRef.current) saveCoordinator.markResourceUnavailable();
      saveCoordinator.start();
    });
    const flushOnPageHide = () => {
      void controller.flush();
      void saveCoordinatorRef.current?.flush();
    };
    window.addEventListener('pagehide', flushOnPageHide);
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', flushOnPageHide);
      saveCoordinatorRef.current?.dispose();
      saveCoordinatorRef.current = null;
      localDraftControllerRef.current = null;
      void controller.dispose();
    };
  }, [
    initialResume.document,
    initialResume.id,
    initialResume.revision,
    localDraft,
    saveTransport,
    store,
  ]);

  useEffect(() => {
    if (!accountUserId) return;
    return subscribeToResumeDeleted(accountUserId, initialResume.id, () => {
      resourceUnavailableRef.current = true;
      void localDraftControllerRef.current?.flush();
      saveCoordinatorRef.current?.markResourceUnavailable();
    });
  }, [accountUserId, initialResume.id]);

  useEffect(() => {
    if (!accountUserId || !localDraft) return;
    let disposed = false;
    let barrier: AccountExitBarrier;
    try {
      barrier = new AccountExitBarrier({
        userId: accountUserId,
        onPrepare: prepareAccountExit,
        onCancel: () => {
          window.location.reload();
        },
        onComplete: () => {
          window.location.replace('/login');
        },
      });
    } catch (error) {
      queueMicrotask(() => {
        if (disposed) return;
        setAccountExit({
          status: 'error',
          message: error instanceof Error ? error.message : '当前浏览器无法安全退出账户',
        });
      });
      return () => {
        disposed = true;
      };
    }
    accountBarrierRef.current = barrier;
    const maskOnPageHide = () => {
      accountLockedRef.current = true;
      setAccountLocked(true);
    };
    const revalidateBfcache = (event: PageTransitionEvent) => {
      if (event.persisted) window.location.reload();
    };
    const revalidateVisibility = () => {
      if (document.visibilityState === 'hidden') maskOnPageHide();
      else if (accountLockedRef.current) window.location.reload();
    };
    window.addEventListener('pagehide', maskOnPageHide);
    window.addEventListener('pageshow', revalidateBfcache);
    document.addEventListener('visibilitychange', revalidateVisibility);
    return () => {
      disposed = true;
      window.removeEventListener('pagehide', maskOnPageHide);
      window.removeEventListener('pageshow', revalidateBfcache);
      document.removeEventListener('visibilitychange', revalidateVisibility);
      if (accountBarrierRef.current === barrier) accountBarrierRef.current = null;
      barrier.dispose();
    };
  }, [accountUserId, localDraft, prepareAccountExit]);

  useEffect(() => {
    const protectUnsyncedExit = (event: BeforeUnloadEvent) => {
      const state = store.getState();
      if (!state.isDirty && !localDraftControllerRef.current?.getPendingEnvelope()) return;
      event.preventDefault();
      Reflect.set(event, 'returnValue', '');
    };
    window.addEventListener('beforeunload', protectUnsyncedExit);
    return () => {
      window.removeEventListener('beforeunload', protectUnsyncedExit);
    };
  }, [store]);

  useEffect(() => {
    if (cloudSaveStatus?.phase !== 'conflict') return;
    const context = saveCoordinatorRef.current?.getConflictContext();
    const abortController = new AbortController();
    queueMicrotask(() => {
      if (abortController.signal.aborted) return;
      setConflictOpen(true);
      if (!context) {
        setConflictView({ status: 'error', message: '本地冲突基线不可用，请先导出救援副本。' });
        return;
      }
      setConflictView({ status: 'loading' });
      void resolvedConflictTransport.loadCurrent(initialResume.id, abortController.signal).then(
        (remote) => {
          if (abortController.signal.aborted) return;
          setConflictView({ status: 'ready', context, remote });
        },
        (error: unknown) => {
          if (abortController.signal.aborted) return;
          setConflictView({
            status: 'error',
            message:
              error instanceof ConflictSnapshotError
                ? error.message
                : '服务器最新版本暂时无法读取，请稍后重试。',
          });
        },
      );
    });
    return () => {
      abortController.abort();
    };
  }, [cloudSaveStatus, conflictLoadAttempt, initialResume.id, resolvedConflictTransport]);

  const exportRescue = () => {
    const controller = localDraftControllerRef.current;
    if (!controller) return;
    downloadJson(controller.createCurrentRescueJson(), `resume-draft-${initialResume.id}.json`);
  };

  const inspectAccountDrafts = async () => {
    if (!accountUserId) throw new Error('缺少账户上下文');
    if (!localDraft) throw new Error('本地草稿不可用');
    const rescueJson = await localDraft.repository.exportAccountRescue(accountUserId);
    const payload = JSON.parse(rescueJson) as { drafts: LocalDraftRecord[] };
    return {
      rescueJson,
      unsyncedCount: payload.drafts.filter(hasUnsyncedLocalChanges).length,
    };
  };

  const finishAccountExit = async (mode: 'synced' | 'rescue' | 'discard') => {
    const barrier = accountBarrierRef.current;
    if (!barrier || !accountUserId) return;
    setAccountExit({ status: 'preparing' });
    try {
      const completed = await barrier.runExclusive(async () => {
        const latest = await inspectAccountDrafts();
        if (latest.unsyncedCount > 0 && mode === 'synced') {
          setAccountExit({
            status: 'decision',
            unsyncedCount: latest.unsyncedCount,
            confirmDiscard: false,
          });
          return false;
        }
        if (mode === 'rescue') {
          downloadJson(latest.rescueJson, `resume-account-${accountUserId}-drafts.json`);
        }
        const response = await fetch('/api/auth/sign-out', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) throw new Error('服务端尚未确认退出');
        if (!localDraft) throw new Error('本地草稿不可用');
        await localDraft.repository.clearAccount(accountUserId, { rescueConfirmed: true });
        return true;
      });
      if (completed) barrier.complete();
    } catch {
      setAccountExit({
        status: 'error',
        message: '退出尚未完成，服务端会话或本地清理未确认；草稿仍被保留。',
      });
    }
  };

  const beginAccountExit = async () => {
    const barrier = accountBarrierRef.current;
    if (!barrier) {
      setAccountExit({ status: 'error', message: '当前浏览器无法安全协调多标签页退出。' });
      return;
    }
    setAccountExit({ status: 'preparing' });
    try {
      const result = await barrier.runExclusive(inspectAccountDrafts);
      if (result.unsyncedCount > 0) {
        setAccountExit({
          status: 'decision',
          unsyncedCount: result.unsyncedCount,
          confirmDiscard: false,
        });
      } else {
        await finishAccountExit('synced');
      }
    } catch {
      setAccountExit({
        status: 'error',
        message: '未能确认所有标签页均已暂停，账户没有退出，本地草稿未清理。',
      });
    }
  };

  const cancelAccountExit = () => {
    const barrier = accountBarrierRef.current;
    if (barrier) barrier.cancel();
    else window.location.reload();
  };

  const flushSave = () => saveCoordinatorRef.current?.flush() ?? Promise.resolve();
  const retrySave = () => saveCoordinatorRef.current?.retryNow() ?? Promise.resolve();
  const renameCurrentResume = async (title: string, idempotencyKey: string) => {
    await flushSave();
    const state = store.getState();
    if (state.isDirty || localDraftControllerRef.current?.getPendingEnvelope()) {
      throw new SaveTransportError('fatal', '请先完成正文保存，再重命名简历');
    }
    const baseRevision = state.ackRevision;
    const receipt = await resolvedRenameTransport.rename({
      resumeId: initialResume.id,
      title,
      baseRevision,
      idempotencyKey,
    });
    const advanced = localDraftControllerRef.current
      ? await localDraftControllerRef.current.advanceRevision(baseRevision, receipt.resume.revision)
      : state.advanceRevision({ baseRevision, revision: receipt.resume.revision });
    if (!advanced) {
      throw new SaveTransportError(
        'conflict',
        '标题已保存，但本地正文版本已变化，请刷新后继续编辑',
        { currentRevision: receipt.resume.revision },
      );
    }
    setResumeTitle(receipt.resume.title);
    setCloudSaveStatus({ phase: 'synced', revision: receipt.resume.revision });
  };
  const adoptRemote = async (
    remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>,
  ) => {
    const adopted = await saveCoordinatorRef.current?.adoptRemote(remote);
    if (adopted) {
      setConflictOpen(false);
      setConflictView({ status: 'idle' });
    }
  };
  const rebaseLocal = async (
    remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>,
  ) => {
    const rebased = await saveCoordinatorRef.current?.rebaseLocalOntoRemote(remote);
    if (rebased && saveCoordinatorRef.current?.getConflictContext() === null) {
      setConflictOpen(false);
    }
  };

  return (
    <ResumeEditorStoreProvider store={store}>
      <EditorWorkspaceContent
        accountExit={accountExit}
        accountLocked={accountLocked}
        canSignOut={Boolean(accountUserId && canSignOut)}
        cloudSaveStatus={cloudSaveStatus}
        conflictOpen={conflictOpen}
        conflictView={conflictView}
        localDraftStatus={localDraftStatus}
        onAdoptRemote={adoptRemote}
        onBeginAccountExit={beginAccountExit}
        onCancelAccountExit={cancelAccountExit}
        onCloseConflict={() => {
          setConflictOpen(false);
        }}
        onExportRescue={exportRescue}
        onFinishAccountExit={finishAccountExit}
        onFlushSave={flushSave}
        onOpenConflict={() => {
          setConflictOpen(true);
        }}
        onRebaseLocal={rebaseLocal}
        onRetryConflictLoad={() => {
          setConflictLoadAttempt((attempt) => attempt + 1);
        }}
        onRetrySave={retrySave}
        onRenameResume={renameCurrentResume}
        onShowDiscardConfirmation={() => {
          setAccountExit((state) =>
            state.status === 'decision' ? { ...state, confirmDiscard: true } : state,
          );
        }}
        resume={{ ...initialResume, title: resumeTitle }}
      />
    </ResumeEditorStoreProvider>
  );
}

function EditorWorkspaceContent({
  resume,
  accountExit,
  accountLocked,
  canSignOut,
  cloudSaveStatus,
  conflictOpen,
  conflictView,
  localDraftStatus,
  onAdoptRemote,
  onBeginAccountExit,
  onCancelAccountExit,
  onCloseConflict,
  onExportRescue,
  onFinishAccountExit,
  onFlushSave,
  onOpenConflict,
  onRebaseLocal,
  onRetryConflictLoad,
  onRetrySave,
  onRenameResume,
  onShowDiscardConfirmation,
}: {
  resume: EditorResume;
  accountExit: AccountExitState;
  accountLocked: boolean;
  canSignOut: boolean;
  cloudSaveStatus: SaveCoordinatorStatus | null;
  conflictOpen: boolean;
  conflictView: ConflictViewState;
  localDraftStatus: LocalDraftStatus | null;
  onAdoptRemote: (
    remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>,
  ) => Promise<void>;
  onBeginAccountExit: () => Promise<void>;
  onCancelAccountExit: () => void;
  onCloseConflict: () => void;
  onExportRescue: () => void;
  onFinishAccountExit: (mode: 'synced' | 'rescue' | 'discard') => Promise<void>;
  onFlushSave: () => Promise<void>;
  onOpenConflict: () => void;
  onRebaseLocal: (
    remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>,
  ) => Promise<void>;
  onRetryConflictLoad: () => void;
  onRetrySave: () => Promise<void>;
  onRenameResume: (title: string, idempotencyKey: string) => Promise<void>;
  onShowDiscardConfirmation: () => void;
}) {
  const resumeDocument = useResumeEditorStore((state) => state.document);
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  const undo = useResumeEditorStore((state) => state.undo);
  const redo = useResumeEditorStore((state) => state.redo);
  const canUndo = useResumeEditorStore((state) => state.canUndo);
  const canRedo = useResumeEditorStore((state) => state.canRedo);
  const isDirty = useResumeEditorStore((state) => state.isDirty);
  const beginHistoryGroup = useResumeEditorStore((state) => state.beginHistoryGroup);
  const endHistoryGroup = useResumeEditorStore((state) => state.endHistoryGroup);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [compactLayout, setCompactLayout] = useState(false);
  const [rightPanelMode, setRightPanelMode] = useState<RightPanelMode>('style');
  const [dismissedSavePhase, setDismissedSavePhase] = useState<string | null>(null);
  const [selectedSectionId, setSelectedSectionId] = useState(resumeDocument.moduleOrder[0] ?? '');
  const [announcement, setAnnouncement] = useState('');
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameTitle, setRenameTitle] = useState(resume.title);
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState('');
  const renameAttemptRef = useRef<{ title: string; idempotencyKey: string } | null>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameDialogRef = useRef<HTMLElement>(null);
  const titleButtonRef = useRef<HTMLButtonElement>(null);
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());

  const openLeftPanel = () => {
    setLeftOpen(true);
    if (compactLayout) setRightOpen(false);
  };
  const openRightPanel = () => {
    setRightOpen(true);
    if (compactLayout) setLeftOpen(false);
  };

  useEffect(() => {
    if (!renameOpen) return;
    renameInputRef.current?.focus();
    renameInputRef.current?.select();
    const handleDialogKeys = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && !renameBusy) {
        setRenameOpen(false);
        titleButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = renameDialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled)',
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', handleDialogKeys);
    return () => {
      window.removeEventListener('keydown', handleDialogKeys);
    };
  }, [renameBusy, renameOpen]);

  const closeRename = () => {
    if (renameBusy) return;
    setRenameOpen(false);
    setRenameError('');
    renameAttemptRef.current = null;
    titleButtonRef.current?.focus();
  };

  const submitRename = async () => {
    const title = renameTitle.trim();
    const length = Array.from(title).length;
    if (length < 1 || length > 200) {
      setRenameError('简历名称须为 1—200 个字符');
      return;
    }
    const attempt =
      renameAttemptRef.current?.title === title
        ? renameAttemptRef.current
        : { title, idempotencyKey: crypto.randomUUID() };
    renameAttemptRef.current = attempt;
    setRenameBusy(true);
    setRenameError('');
    try {
      await onRenameResume(attempt.title, attempt.idempotencyKey);
      setRenameOpen(false);
      renameAttemptRef.current = null;
      setAnnouncement(`简历已重命名为${attempt.title}`);
      titleButtonRef.current?.focus();
    } catch (error) {
      if (error instanceof SaveTransportError) {
        setRenameError(
          error.kind === 'conflict'
            ? '服务器版本已更新，请刷新页面后重试'
            : error.kind === 'auth'
              ? '登录状态已失效，请重新登录后重试'
              : error.message,
        );
      } else {
        setRenameError('暂时无法重命名，请稍后重试');
      }
    } finally {
      setRenameBusy(false);
    }
  };

  const selectedSection = resumeDocument.sectionsById[selectedSectionId];
  const orderedSections = resumeDocument.moduleOrder.flatMap((id) => {
    const sectionValue = resumeDocument.sectionsById[id];
    return sectionValue ? [sectionValue] : [];
  });
  const renderModel = useMemo(
    () =>
      createResumeRenderModel({
        document: resumeDocument,
        templateManifest: ATS_BASIC_TEMPLATE_MANIFEST,
        fontManifest: DEFAULT_FONT_MANIFEST,
        renderPolicy: RENDER_POLICY_V1,
      }),
    [resumeDocument],
  );
  const flow = useMemo(() => createRenderFlow(renderModel), [renderModel]);
  const metrics = useMemo(() => getA4PageMetrics(renderModel.page), [renderModel.page]);
  const [measuredFlow, setMeasuredFlow] = useState<{
    flow: readonly RenderFlowBlock[];
    values: Record<string, RenderBlockMeasurement>;
  } | null>(null);
  const measurementRootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    let cancelled = false;
    const measure = () => {
      if (cancelled || !measurementRootRef.current) return;
      const next: Record<string, RenderBlockMeasurement> = {};
      const blocks = new Map(flow.map((block) => [block.key, block]));
      measurementRootRef.current
        .querySelectorAll<HTMLElement>('[data-render-block-key]')
        .forEach((element) => {
          const key = element.dataset.renderBlockKey;
          if (!key) return;
          const block = blocks.get(key);
          const heightPx = measureElementHeight(element);
          const lineFragments =
            block &&
            heightPx > metrics.contentHeightPx &&
            (block.kind === 'paragraph' || block.kind === 'bullet')
              ? measureWrappedText(element, block.text)
              : undefined;
          next[key] = lineFragments ? { heightPx, lineFragments } : { heightPx };
        });
      if (Object.keys(next).length === flow.length && flow.length > 0) {
        setMeasuredFlow({ flow, values: next });
      }
    };
    const fontsReady =
      'fonts' in globalThis.document ? globalThis.document.fonts.ready : Promise.resolve();
    void fontsReady.then(() => {
      scheduleNextFrame(measure);
    });
    return () => {
      cancelled = true;
    };
  }, [flow, metrics.contentHeightPx]);

  const measurements =
    measuredFlow?.flow === flow ? measuredFlow.values : estimatedMeasurements(flow);
  const assetsReady = flow.length === 0 || measuredFlow?.flow === flow;
  const pagination = useMemo(
    () => paginateRenderFlow(flow, measurements, metrics.contentHeightPx),
    [flow, measurements, metrics.contentHeightPx],
  );
  const previewRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 900, height: 900 });
  const [scaleMode, setScaleMode] = useState<'manual' | 'fit-page'>('fit-page');
  const [manualScale, setManualScale] = useState(0.75);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const narrowMedia = window.matchMedia('(max-width: 1280px)');
    const compactMedia = window.matchMedia('(max-width: 800px)');
    const collapseForViewport = () => {
      setCompactLayout(compactMedia.matches);
      if (compactMedia.matches) {
        setLeftOpen(false);
        setRightOpen(false);
      } else if (narrowMedia.matches) {
        setRightOpen(false);
      }
    };
    const timer = window.setTimeout(collapseForViewport, 0);
    narrowMedia.addEventListener('change', collapseForViewport);
    compactMedia.addEventListener('change', collapseForViewport);
    return () => {
      window.clearTimeout(timer);
      narrowMedia.removeEventListener('change', collapseForViewport);
      compactMedia.removeEventListener('change', collapseForViewport);
    };
  }, []);

  useLayoutEffect(() => {
    const node = previewRef.current;
    if (!node) return;
    const update = () => {
      if (node.clientWidth > 0 && node.clientHeight > 0) {
        setViewport({ width: node.clientWidth, height: node.clientHeight });
      }
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const scale = computePreviewScale({
    mode: scaleMode,
    viewportWidthPx: viewport.width,
    viewportHeightPx: viewport.height,
    manualScale,
    horizontalPaddingPx: 72,
    verticalPaddingPx: 104,
  });

  const focusAction = (sectionId: string, action: string) => {
    focusOnNextFrame(() => actionRefs.current.get(`${sectionId}:${action}`));
  };
  const moveSection = (sectionId: string, toIndex: number, action = 'drag') => {
    const fromIndex = resumeDocument.moduleOrder.indexOf(sectionId);
    if (fromIndex < 0 || toIndex < 0 || toIndex >= resumeDocument.moduleOrder.length) return;
    const sectionValue = resumeDocument.sectionsById[sectionId];
    if (!sectionValue || !dispatch({ type: 'move-section', sectionId, toIndex })) return;
    setAnnouncement(`${sectionValue.title}已移动到第 ${String(toIndex + 1)} 位`);
    focusAction(sectionId, action);
  };
  const handleSortKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    sectionId: string,
    index: number,
  ) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    moveSection(sectionId, index + (event.key === 'ArrowUp' ? -1 : 1), 'drag');
  };
  const handleDrop = (event: DragEvent<HTMLLIElement>, toIndex: number) => {
    event.preventDefault();
    if (draggedSectionId) moveSection(draggedSectionId, toIndex);
    setDraggedSectionId(null);
  };
  const toggleVisibility = (sectionValue: ContentSection) => {
    dispatch({
      type: 'set-section-visibility',
      sectionId: sectionValue.id,
      visible: !sectionValue.visible,
    });
    setAnnouncement(`${sectionValue.title}已${sectionValue.visible ? '隐藏' : '显示'}`);
    focusAction(sectionValue.id, 'visibility');
  };
  const restoreDefault = () => {
    dispatch({ type: 'restore-default-section-layout' });
    setAnnouncement('已恢复默认模块顺序和显示状态');
    focusOnNextFrame(() => actionRefs.current.get('layout:restore'));
  };
  const addCustomSection = () => {
    const title = customTitle.trim();
    if (!title) return;
    dispatch({ type: 'add-custom-section', title });
    setCustomTitle('');
    setAnnouncement(`已新增模块${title}`);
  };

  const saveLabel = (() => {
    if (!cloudSaveStatus) return isDirty ? '有未保存修改' : '已保存';
    switch (cloudSaveStatus.phase) {
      case 'synced':
        return localDraftStatus?.phase === 'error' ? '云端已保存 · 本地备份不可用' : '已保存';
      case 'saving':
        return '正在保存';
      case 'retry-wait':
        return '正在重新保存…';
      case 'failed':
        return cloudSaveStatus.kind === 'resource-gone'
          ? '简历已删除 · 已暂停自动保存'
          : '保存失败';
      case 'conflict':
        return '版本冲突 · 已暂停自动保存';
      case 'auth-paused':
        return '登录状态失效 · 已暂停自动保存';
      case 'validation-error':
        return '内容校验失败 · 尚未保存';
      case 'dirty':
      case 'debouncing':
        if (localDraftStatus?.phase === 'error') return '本地备份不可用 · 尚未云端保存';
        if (localDraftStatus?.phase === 'initializing') return '正在检查本地草稿';
        if (localDraftStatus?.phase === 'backing-up') return '正在本地备份';
        if (localDraftStatus?.phase === 'recovered') {
          return '已恢复本地草稿 · 尚未云端保存';
        }
        return '已本地备份 · 尚未云端保存';
    }
  })();
  const canRetry =
    cloudSaveStatus?.phase === 'retry-wait' ||
    (cloudSaveStatus?.phase === 'failed' &&
      cloudSaveStatus.kind !== 'resource-gone' &&
      cloudSaveStatus.canRetry);

  return (
    <main
      className={classNames(
        styles.editorShell,
        !leftOpen && styles.leftCollapsed,
        !rightOpen && styles.rightCollapsed,
        accountLocked && styles.accountLocked,
      )}
      data-editor-shell
    >
      <header className={styles.topbar}>
        <div className={styles.topbarStart}>
          <a className={styles.backButton} href="/resumes" title="返回工作台">
            <EditorIcon name="arrow-left" size={20} />
            <span>返回工作台</span>
          </a>
          <span aria-hidden="true" className={styles.topbarDivider} />
          <button
            className={styles.titleButton}
            onClick={() => {
              setRenameTitle(resume.title);
              setRenameError('');
              renameAttemptRef.current = null;
              setRenameOpen(true);
            }}
            ref={titleButtonRef}
            title="重命名简历"
            type="button"
          >
            <strong>{resume.title}</strong>
            <EditorIcon name="pencil" size={17} />
          </button>
        </div>
        <div className={styles.saveStateGroup} data-phase={cloudSaveStatus?.phase}>
          <EditorIcon name="check-circle" size={20} />
          <span aria-live="polite" className={styles.saveState} role="status">
            {saveLabel}
          </span>
          {canRetry ? (
            <button className={styles.retryButton} onClick={() => void onRetrySave()} type="button">
              {cloudSaveStatus.phase === 'retry-wait' ? '重试' : '重新保存'}
            </button>
          ) : null}
          {cloudSaveStatus?.phase === 'conflict' ? (
            <button className={styles.conflictButton} onClick={onOpenConflict} type="button">
              查看冲突
            </button>
          ) : null}
          {localDraftStatus?.phase === 'error' && isDirty ? (
            <button className={styles.rescueButton} onClick={onExportRescue} type="button">
              导出救援副本
            </button>
          ) : null}
        </div>
        <div className={styles.topbarActions}>
          <button
            aria-label="撤销"
            disabled={!canUndo}
            onClick={() => undo()}
            title="撤销"
            type="button"
          >
            <EditorIcon name="undo" size={19} />
            <span>撤销</span>
          </button>
          <button
            aria-label="重做"
            disabled={!canRedo}
            onClick={() => redo()}
            title="重做"
            type="button"
          >
            <EditorIcon name="redo" size={19} />
            <span>重做</span>
          </button>
          {canSignOut ? (
            <button onClick={() => void onBeginAccountExit()} type="button">
              退出
            </button>
          ) : null}
        </div>
      </header>

      <nav aria-label="简历模块" className={styles.leftRail}>
        <div className={styles.railItems}>
          {orderedSections.map((sectionValue) => (
            <button
              aria-current={selectedSectionId === sectionValue.id ? 'page' : undefined}
              aria-label={sectionValue.title}
              className={selectedSectionId === sectionValue.id ? styles.railItemActive : undefined}
              data-visible={sectionValue.visible}
              key={sectionValue.id}
              onClick={() => {
                setSelectedSectionId(sectionValue.id);
                openLeftPanel();
              }}
              title={sectionValue.title}
              type="button"
            >
              <EditorIcon name={moduleGlyph[sectionValue.kind]} size={22} />
            </button>
          ))}
        </div>
        {!leftOpen ? (
          <button
            aria-expanded="false"
            aria-label="展开内容面板"
            className={styles.railEdgeToggle}
            onClick={() => {
              openLeftPanel();
            }}
            title="展开内容编辑"
            type="button"
          >
            <EditorIcon name="chevron-right" size={16} />
          </button>
        ) : null}
      </nav>

      <aside aria-label="内容编辑" className={styles.leftPanel} hidden={!leftOpen}>
        <div className={styles.panelHeader}>
          <div>
            <h1>{selectedSection?.title ?? '简历内容'}</h1>
            <p>
              {selectedSection?.kind === 'basic'
                ? '完善你的联系方式与个人介绍'
                : '编辑模块内容，预览将实时更新'}
            </p>
          </div>
          <button
            aria-label="收起内容面板"
            className={styles.edgeToggle}
            onClick={() => {
              setLeftOpen(false);
            }}
            type="button"
          >
            <EditorIcon name="chevron-left" size={16} />
          </button>
        </div>
        {selectedSection ? (
          <section className={styles.sectionEditor}>
            <label className={styles.moduleTitleField}>
              <span>模块标题</span>
              <input
                onBlur={() => {
                  endHistoryGroup(`section-title:${selectedSection.id}`);
                  void onFlushSave();
                }}
                onChange={(event) =>
                  dispatch({
                    type: 'set-section-title',
                    sectionId: selectedSection.id,
                    title: event.target.value,
                  })
                }
                onFocus={() => {
                  beginHistoryGroup(`section-title:${selectedSection.id}`);
                }}
                value={selectedSection.title}
              />
            </label>
            {selectedSection.kind === 'basic' ? (
              <div className={styles.avatarRow}>
                <div aria-hidden="true" className={styles.avatarPlaceholder}>
                  <EditorIcon name="basic" size={44} />
                </div>
                <strong>上传头像</strong>
                <button type="button">选择图片</button>
              </div>
            ) : (
              <div className={styles.sectionSummary}>
                <span>{selectedSection.entries.length} 条内容</span>
                <span>{selectedSection.visible ? '在预览中显示' : '当前已隐藏'}</span>
              </div>
            )}
            {repeatableKinds.has(selectedSection.kind) ? (
              <button
                className={styles.secondaryButton}
                onClick={() => dispatch({ type: 'add-entry', sectionId: selectedSection.id })}
                type="button"
              >
                新增一条内容
              </button>
            ) : null}
            <SectionFieldsEditor onFlushSave={onFlushSave} section={selectedSection} />
          </section>
        ) : null}
        <div className={styles.leftPanelFooter}>
          <button
            onClick={() => {
              setRightPanelMode('modules');
              openRightPanel();
            }}
            type="button"
          >
            <EditorIcon name="plus" size={20} />
            新增模块
          </button>
          <button
            onClick={() => {
              setRightPanelMode('sorting');
              openRightPanel();
            }}
            type="button"
          >
            <EditorIcon name="sort" size={20} />
            模块排序
          </button>
        </div>
      </aside>

      <section aria-label="A4 简历预览" className={styles.preview} ref={previewRef}>
        <div className={styles.measurementRoot} ref={measurementRootRef}>
          <ResumeMeasurementSurface flow={flow} model={renderModel} />
        </div>
        <div className={styles.pagesScroller}>
          <div
            className={styles.scaledPageSlot}
            style={{
              height: metrics.heightPx * scale * pagination.pages.length,
              width: metrics.widthPx * scale,
            }}
          >
            <div className={styles.scaledPages} style={{ transform: `scale(${String(scale)})` }}>
              <ResumePages assetsReady={assetsReady} model={renderModel} pagination={pagination} />
            </div>
          </div>
        </div>
        <div aria-label="预览缩放" className={styles.zoomControls} role="group">
          <button
            aria-label="缩小预览"
            onClick={() => {
              setScaleMode('manual');
              setManualScale(Math.max(0.25, scale - 0.1));
            }}
            type="button"
          >
            −
          </button>
          <output>{Math.round(scale * 100)}%</output>
          <button
            aria-label="放大预览"
            onClick={() => {
              setScaleMode('manual');
              setManualScale(Math.min(2, scale + 0.1));
            }}
            type="button"
          >
            +
          </button>
          <button
            onClick={() => {
              setScaleMode('fit-page');
            }}
            type="button"
          >
            适合页面
          </button>
        </div>
      </section>

      <aside aria-label="布局设置" className={styles.rightPanel} hidden={!rightOpen}>
        <div className={styles.panelHeader}>
          <div>
            <h2>
              {rightPanelMode === 'style'
                ? '模板与样式'
                : rightPanelMode === 'modules'
                  ? '模块管理'
                  : '布局'}
            </h2>
            <p>
              {rightPanelMode === 'style'
                ? '调整简历的整体视觉与页面设置'
                : rightPanelMode === 'modules'
                  ? '控制简历模块的显示状态'
                  : '拖动模块调整简历中的显示顺序'}
            </p>
          </div>
          {rightPanelMode !== 'style' ? (
            <button
              className={styles.textAction}
              onClick={restoreDefault}
              ref={(node) => {
                if (node) actionRefs.current.set('layout:restore', node);
                else actionRefs.current.delete('layout:restore');
              }}
              type="button"
            >
              {rightPanelMode === 'modules' ? '恢复默认' : '恢复默认顺序'}
            </button>
          ) : null}
          <button
            aria-label="收起设置面板"
            className={styles.edgeToggle}
            onClick={() => {
              setRightOpen(false);
            }}
            type="button"
          >
            <EditorIcon name="chevron-right" size={16} />
          </button>
        </div>

        {rightPanelMode === 'style' ? (
          <div className={styles.stylePanel}>
            <div className={styles.templateChoice}>
              <div className={styles.templateThumbnail}>
                <div>
                  <strong>张三</strong>
                  <span />
                  <span />
                  <span />
                  <span />
                </div>
              </div>
              <strong>简洁单栏</strong>
            </div>
            <fieldset className={styles.colorFieldset}>
              <legend>主题颜色</legend>
              {['#171717', '#343434', '#8b8b8b', '#34495e', '#d9b29e'].map((color, index) => (
                <button
                  aria-label={`主题颜色 ${String(index + 1)}`}
                  className={index === 0 ? styles.colorSelected : undefined}
                  key={color}
                  style={{ background: color }}
                  type="button"
                />
              ))}
            </fieldset>
            <div className={styles.settingRows}>
              <label>
                <span>字体选择</span>
                <select defaultValue="noto">
                  <option value="noto">Noto Sans SC</option>
                </select>
              </label>
              <label>
                <span>字重选择</span>
                <select defaultValue="400">
                  <option value="400">常规 400</option>
                  <option value="600">中等 600</option>
                </select>
              </label>
              <label>
                <span>页面格式</span>
                <select defaultValue="a4">
                  <option value="a4">A4</option>
                </select>
              </label>
            </div>
            <fieldset className={styles.marginFieldset}>
              <legend>页面边距</legend>
              <label>
                <span>上</span>
                <input defaultValue="18" />
                <b>mm</b>
              </label>
              <label>
                <span>下</span>
                <input defaultValue="18" />
                <b>mm</b>
              </label>
              <label>
                <span>左</span>
                <input defaultValue="20" />
                <b>mm</b>
              </label>
              <label>
                <span>右</span>
                <input defaultValue="20" />
                <b>mm</b>
              </label>
            </fieldset>
            <div className={styles.settingToggles}>
              {['显示头像', '显示联系方式', '显示分隔线'].map((label, index) => (
                <div key={label}>
                  <span>{label}</span>
                  <button
                    aria-checked={index > 0}
                    className={styles.visibilitySwitch}
                    role="switch"
                    type="button"
                  >
                    <span />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {rightPanelMode === 'modules' ? (
          <>
            <ol aria-label="模块显示状态" className={styles.moduleManageList}>
              {orderedSections.map((sectionValue) => (
                <li className={styles.moduleManageRow} key={sectionValue.id}>
                  <EditorIcon name={moduleGlyph[sectionValue.kind]} size={23} />
                  <button
                    className={styles.moduleName}
                    onClick={() => {
                      setSelectedSectionId(sectionValue.id);
                      openLeftPanel();
                    }}
                    type="button"
                  >
                    <span>{sectionValue.title}</span>
                  </button>
                  <button
                    aria-checked={sectionValue.visible}
                    aria-label={`${sectionValue.visible ? '隐藏' : '显示'}${sectionValue.title}`}
                    className={styles.visibilitySwitch}
                    onClick={() => {
                      toggleVisibility(sectionValue);
                    }}
                    ref={(node) => {
                      if (node) actionRefs.current.set(`${sectionValue.id}:visibility`, node);
                      else actionRefs.current.delete(`${sectionValue.id}:visibility`);
                    }}
                    role="switch"
                    type="button"
                  >
                    <span />
                  </button>
                  <button
                    aria-label={`${sectionValue.title}更多操作`}
                    className={styles.moreButton}
                    type="button"
                  >
                    <EditorIcon name="more" size={19} />
                  </button>
                </li>
              ))}
            </ol>
            <div className={styles.modulePanelFooter}>
              <div className={styles.customModuleForm}>
                <label className={styles.srOnly} htmlFor="custom-module-title">
                  新增自定义模块
                </label>
                <input
                  id="custom-module-title"
                  maxLength={100}
                  onChange={(event) => {
                    setCustomTitle(event.target.value);
                  }}
                  placeholder="自定义模块名称"
                  value={customTitle}
                />
                <button disabled={!customTitle.trim()} onClick={addCustomSection} type="button">
                  <EditorIcon name="plus" size={20} />
                  新增自定义模块
                </button>
              </div>
              <button
                className={styles.manageOrderButton}
                onClick={() => {
                  setRightPanelMode('sorting');
                }}
                type="button"
              >
                <EditorIcon name="sort" size={20} />
                管理模块顺序
              </button>
            </div>
          </>
        ) : null}

        {rightPanelMode === 'sorting' ? (
          <>
            <ol aria-label="模块顺序" className={styles.moduleList}>
              {orderedSections.map((sectionValue, index) => (
                <li
                  className={styles.moduleRow}
                  data-section-id={sectionValue.id}
                  key={sectionValue.id}
                  onDragOver={(event) => {
                    event.preventDefault();
                  }}
                  onDrop={(event) => {
                    handleDrop(event, index);
                  }}
                >
                  <button
                    aria-label={`拖动${sectionValue.title}，可使用上下方向键排序`}
                    className={styles.dragHandle}
                    draggable
                    onDragEnd={() => {
                      setDraggedSectionId(null);
                    }}
                    onDragStart={(event) => {
                      setDraggedSectionId(sectionValue.id);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setData('text/plain', sectionValue.id);
                    }}
                    onKeyDown={(event) => {
                      handleSortKey(event, sectionValue.id, index);
                    }}
                    ref={(node) => {
                      if (node) actionRefs.current.set(`${sectionValue.id}:drag`, node);
                      else actionRefs.current.delete(`${sectionValue.id}:drag`);
                    }}
                    type="button"
                  >
                    ⠿
                  </button>
                  <EditorIcon name={moduleGlyph[sectionValue.kind]} size={22} />
                  <button
                    className={styles.moduleName}
                    onClick={() => {
                      setSelectedSectionId(sectionValue.id);
                      openLeftPanel();
                    }}
                    type="button"
                  >
                    <span>{sectionValue.title}</span>
                  </button>
                  <button
                    aria-checked={sectionValue.visible}
                    aria-label={`${sectionValue.visible ? '隐藏' : '显示'}${sectionValue.title}`}
                    className={styles.visibilitySwitch}
                    onClick={() => {
                      toggleVisibility(sectionValue);
                    }}
                    ref={(node) => {
                      if (node) actionRefs.current.set(`${sectionValue.id}:visibility`, node);
                      else actionRefs.current.delete(`${sectionValue.id}:visibility`);
                    }}
                    role="switch"
                    type="button"
                  >
                    <span />
                  </button>
                  <button
                    aria-label={`${sectionValue.title}更多操作`}
                    className={styles.moreButton}
                    type="button"
                  >
                    <EditorIcon name="more" size={19} />
                  </button>
                </li>
              ))}
            </ol>
            <div className={styles.sortingFooter}>
              <button
                onClick={() => {
                  setRightPanelMode('modules');
                }}
                type="button"
              >
                新增自定义模块
              </button>
              <button
                className={styles.primaryButton}
                onClick={() => {
                  setRightPanelMode('style');
                }}
                type="button"
              >
                完成排序
              </button>
            </div>
          </>
        ) : null}
        <button className={styles.restoreButton} hidden onClick={restoreDefault} type="button">
          恢复默认顺序与显示
        </button>
        <div aria-label="模块操作通知" aria-live="polite" className={styles.srOnly} role="status">
          {announcement}
        </div>
      </aside>

      <nav aria-label="编辑器工具" className={styles.rightRail}>
        {(
          [
            ['style', 'template', '模板'],
            ['modules', 'modules', '模块'],
            ['style', 'typography', '排版'],
            ['style', 'design', '设计'],
            ['style', 'export', '页面'],
          ] as const
        ).map(([mode, icon, label]) => (
          <button
            aria-current={
              rightOpen &&
              ((label === '模板' && rightPanelMode === 'style') ||
                (label === '模块' && rightPanelMode === 'modules'))
                ? 'page'
                : undefined
            }
            aria-label={label}
            key={`${icon}-${label}`}
            onClick={() => {
              setRightPanelMode(mode);
              openRightPanel();
            }}
            title={label}
            type="button"
          >
            <EditorIcon name={icon} size={22} />
          </button>
        ))}
        {!rightOpen ? (
          <button
            aria-expanded="false"
            aria-label="展开模块布局设置"
            className={styles.railEdgeToggle}
            onClick={() => {
              openRightPanel();
            }}
            title="展开设置面板"
            type="button"
          >
            <EditorIcon name="chevron-left" size={16} />
          </button>
        ) : null}
      </nav>
      {accountExit.status !== 'idle' ? (
        <div className={styles.dialogBackdrop}>
          <section
            aria-labelledby="account-exit-title"
            aria-modal="true"
            className={styles.conflictDialog}
            role="dialog"
          >
            <header className={styles.conflictHeader}>
              <div>
                <span className={styles.eyebrow}>账户安全</span>
                <h2 id="account-exit-title">
                  {accountExit.status === 'preparing'
                    ? '正在暂停所有编辑标签页'
                    : accountExit.status === 'error'
                      ? '尚未完成退出'
                      : accountExit.confirmDiscard
                        ? '确认放弃未同步修改'
                        : '退出前处理本地修改'}
                </h2>
              </div>
            </header>
            <p className={styles.conflictDescription}>
              {accountExit.status === 'preparing'
                ? '正在落盘本地修改并等待其他标签页停止上传。'
                : accountExit.status === 'error'
                  ? accountExit.message
                  : accountExit.confirmDiscard
                    ? `将永久清除本机该账户的 ${String(accountExit.unsyncedCount)} 份未同步草稿。此操作无法撤销。`
                    : `发现 ${String(accountExit.unsyncedCount)} 份未同步草稿。请先保存，或下载救援副本后退出。`}
            </p>
            {accountExit.status === 'decision' ? (
              <footer className={styles.conflictActions}>
                <button onClick={onCancelAccountExit} type="button">
                  返回编辑并先保存
                </button>
                {!accountExit.confirmDiscard ? (
                  <>
                    <button onClick={() => void onFinishAccountExit('rescue')} type="button">
                      下载救援并退出
                    </button>
                    <button onClick={onShowDiscardConfirmation} type="button">
                      放弃修改
                    </button>
                  </>
                ) : (
                  <button onClick={() => void onFinishAccountExit('discard')} type="button">
                    确认放弃并退出
                  </button>
                )}
              </footer>
            ) : null}
            {accountExit.status === 'error' ? (
              <footer className={styles.conflictActions}>
                <button onClick={onCancelAccountExit} type="button">
                  返回编辑
                </button>
                <button onClick={() => void onBeginAccountExit()} type="button">
                  重新检查并退出
                </button>
              </footer>
            ) : null}
          </section>
        </div>
      ) : null}
      {renameOpen ? (
        <div className={styles.dialogBackdrop}>
          <section
            aria-labelledby="rename-resume-title"
            aria-modal="true"
            className={classNames(styles.conflictDialog, styles.renameDialog)}
            ref={renameDialogRef}
            role="dialog"
          >
            <header className={styles.conflictHeader}>
              <div>
                <span className={styles.eyebrow}>简历名称</span>
                <h2 id="rename-resume-title">重命名简历</h2>
              </div>
              <button
                aria-label="关闭重命名"
                disabled={renameBusy}
                onClick={closeRename}
                type="button"
              >
                ×
              </button>
            </header>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submitRename();
              }}
            >
              <label className={styles.renameField}>
                <span>简历名称</span>
                <input
                  aria-describedby={renameError ? 'rename-resume-error' : undefined}
                  disabled={renameBusy}
                  maxLength={400}
                  onChange={(event) => {
                    setRenameTitle(event.currentTarget.value);
                    setRenameError('');
                    renameAttemptRef.current = null;
                  }}
                  ref={renameInputRef}
                  value={renameTitle}
                />
              </label>
              {renameError ? (
                <p className={styles.renameError} id="rename-resume-error" role="alert">
                  {renameError}
                </p>
              ) : null}
              <footer className={styles.conflictActions}>
                <button disabled={renameBusy} onClick={closeRename} type="button">
                  取消
                </button>
                <button
                  className={styles.conflictPrimaryAction}
                  disabled={renameBusy}
                  type="submit"
                >
                  {renameBusy ? '正在保存' : '保存名称'}
                </button>
              </footer>
            </form>
          </section>
        </div>
      ) : null}
      {cloudSaveStatus?.phase === 'auth-paused' ? (
        <section
          aria-label="登录状态通知"
          className={styles.saveNotice}
          data-phase="auth-paused"
          role="alert"
        >
          <span aria-hidden="true" className={styles.saveNoticeIcon}>
            !
          </span>
          <div>
            <strong>登录状态已失效</strong>
            <p>最新修改已停止上传。重新登录同一账户后返回本页即可继续保存。</p>
            <div>
              <a href={`/login?returnTo=${encodeURIComponent(`/resumes/${resume.id}/edit`)}`}>
                重新登录
              </a>
              <button onClick={onExportRescue} type="button">
                导出救援副本
              </button>
            </div>
          </div>
        </section>
      ) : null}
      {cloudSaveStatus?.phase === 'failed' && cloudSaveStatus.kind === 'resource-gone' ? (
        <section
          aria-label="简历删除通知"
          className={styles.saveNotice}
          data-phase="resource-gone"
          role="alert"
        >
          <span aria-hidden="true" className={styles.saveNoticeIcon}>
            !
          </span>
          <div>
            <strong>简历已删除或不可用</strong>
            <p>此标签页已停止上传。本地修改不会自动恢复或覆盖服务器；请先导出救援副本。</p>
            <div>
              <button onClick={onExportRescue} type="button">
                导出救援副本
              </button>
              <a href="/resumes/trash">前往最近删除</a>
              <button onClick={() => void onRetrySave()} type="button">
                恢复后重新检查
              </button>
            </div>
          </div>
        </section>
      ) : null}
      {(cloudSaveStatus?.phase === 'failed' || cloudSaveStatus?.phase === 'retry-wait') &&
      !(cloudSaveStatus.phase === 'failed' && cloudSaveStatus.kind === 'resource-gone') &&
      dismissedSavePhase !== cloudSaveStatus.phase ? (
        <section
          aria-label="保存状态通知"
          className={styles.saveNotice}
          data-phase={cloudSaveStatus.phase}
          role="alert"
        >
          <span aria-hidden="true" className={styles.saveNoticeIcon}>
            {cloudSaveStatus.phase === 'retry-wait' ? '◌' : '!'}
          </span>
          <div>
            <strong>
              {cloudSaveStatus.phase === 'retry-wait' ? '正在同步最新修改' : '无法保存最新修改'}
            </strong>
            <p>网络连接异常，你的内容暂时保存在本地。</p>
            <div>
              <button onClick={() => void onRetrySave()} type="button">
                重新保存
              </button>
              <button
                onClick={() => {
                  setDismissedSavePhase(cloudSaveStatus.phase);
                }}
                type="button"
              >
                稍后重试
              </button>
            </div>
          </div>
          <button
            aria-label="关闭保存状态通知"
            className={styles.saveNoticeClose}
            onClick={() => {
              setDismissedSavePhase(cloudSaveStatus.phase);
            }}
            type="button"
          >
            ×
          </button>
        </section>
      ) : null}
      {conflictOpen && conflictView.status === 'ready' ? (
        <ConflictDialog
          context={conflictView.context}
          localDocument={resumeDocument}
          onAdoptRemote={onAdoptRemote}
          onClose={onCloseConflict}
          onExportLocal={onExportRescue}
          onRebaseLocal={onRebaseLocal}
          remote={conflictView.remote}
        />
      ) : null}
      {conflictOpen && (conflictView.status === 'loading' || conflictView.status === 'error') ? (
        <div className={styles.dialogBackdrop}>
          <section
            aria-labelledby="conflict-load-title"
            aria-modal="true"
            className={styles.conflictDialog}
            role="dialog"
          >
            <header className={styles.conflictHeader}>
              <div>
                <span className={styles.eyebrow}>保存已暂停</span>
                <h2 id="conflict-load-title">
                  {conflictView.status === 'loading' ? '正在读取服务器版本' : '无法读取服务器版本'}
                </h2>
              </div>
              <button aria-label="关闭冲突处理" onClick={onCloseConflict} type="button">
                ×
              </button>
            </header>
            <p className={styles.conflictDescription}>
              {conflictView.status === 'loading'
                ? '正在准备基线、本地和服务器三方对比。'
                : conflictView.message}
            </p>
            <footer className={styles.conflictActions}>
              <button onClick={onExportRescue} type="button">
                导出本地救援副本
              </button>
              {conflictView.status === 'error' ? (
                <button onClick={onRetryConflictLoad} type="button">
                  重新读取服务器版本
                </button>
              ) : null}
              <button onClick={onCloseConflict} type="button">
                暂时关闭
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </main>
  );
}
