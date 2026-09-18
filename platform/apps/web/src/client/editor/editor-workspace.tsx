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
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from 'react';

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
  SaveCoordinator,
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
import styles from './editor-workspace.module.css';

export interface EditorResume {
  id: string;
  title: string;
  document: ResumeDocumentV1;
  revision: string;
}

export interface EditorWorkspaceProps {
  initialResume: EditorResume;
  store?: ResumeEditorStore;
  localDraft?: EditorLocalDraftContext;
  saveTransport?: SaveTransport;
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

const moduleGlyph: Record<ContentSection['kind'], string> = {
  basic: '人',
  intent: '向',
  summary: '概',
  education: '学',
  work: '职',
  project: '项',
  internship: '实',
  campus: '校',
  skillsCertificates: '技',
  awards: '奖',
  selfEvaluation: '评',
  custom: '自',
};

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

export function EditorWorkspace({
  initialResume,
  store: providedStore,
  localDraft,
  saveTransport,
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
  const localDraftControllerRef = useRef<LocalDraftController | null>(null);
  const saveCoordinatorRef = useRef<SaveCoordinator | null>(null);
  const [resolvedConflictTransport] = useState(
    () => conflictSnapshotTransport ?? new HttpConflictSnapshotTransport(),
  );
  const [conflictView, setConflictView] = useState<ConflictViewState>({ status: 'idle' });
  const [conflictOpen, setConflictOpen] = useState(false);
  const [conflictLoadAttempt, setConflictLoadAttempt] = useState(0);

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
    void controller.start().then(() => {
      if (disposed) return;
      const saveCoordinator = new SaveCoordinator({
        resumeId: initialResume.id,
        store,
        persistence: controller,
        transport: saveTransport ?? new HttpSaveTransport(),
        onStatus: setCloudSaveStatus,
      });
      saveCoordinatorRef.current = saveCoordinator;
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
    const blob = new Blob([controller.createCurrentRescueJson()], {
      type: 'application/json;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `resume-draft-${initialResume.id}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const flushSave = () => saveCoordinatorRef.current?.flush() ?? Promise.resolve();
  const retrySave = () => saveCoordinatorRef.current?.retryNow() ?? Promise.resolve();
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
        cloudSaveStatus={cloudSaveStatus}
        conflictOpen={conflictOpen}
        conflictView={conflictView}
        localDraftStatus={localDraftStatus}
        onAdoptRemote={adoptRemote}
        onCloseConflict={() => {
          setConflictOpen(false);
        }}
        onExportRescue={exportRescue}
        onFlushSave={flushSave}
        onOpenConflict={() => {
          setConflictOpen(true);
        }}
        onRebaseLocal={rebaseLocal}
        onRetryConflictLoad={() => {
          setConflictLoadAttempt((attempt) => attempt + 1);
        }}
        onRetrySave={retrySave}
        resume={initialResume}
      />
    </ResumeEditorStoreProvider>
  );
}

function EditorWorkspaceContent({
  resume,
  cloudSaveStatus,
  conflictOpen,
  conflictView,
  localDraftStatus,
  onAdoptRemote,
  onCloseConflict,
  onExportRescue,
  onFlushSave,
  onOpenConflict,
  onRebaseLocal,
  onRetryConflictLoad,
  onRetrySave,
}: {
  resume: EditorResume;
  cloudSaveStatus: SaveCoordinatorStatus | null;
  conflictOpen: boolean;
  conflictView: ConflictViewState;
  localDraftStatus: LocalDraftStatus | null;
  onAdoptRemote: (
    remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>,
  ) => Promise<void>;
  onCloseConflict: () => void;
  onExportRescue: () => void;
  onFlushSave: () => Promise<void>;
  onOpenConflict: () => void;
  onRebaseLocal: (
    remote: Awaited<ReturnType<ConflictSnapshotTransport['loadCurrent']>>,
  ) => Promise<void>;
  onRetryConflictLoad: () => void;
  onRetrySave: () => Promise<void>;
}) {
  const resumeDocument = useResumeEditorStore((state) => state.document);
  const dispatch = useResumeEditorStore((state) => state.dispatch);
  const undo = useResumeEditorStore((state) => state.undo);
  const redo = useResumeEditorStore((state) => state.redo);
  const canUndo = useResumeEditorStore((state) => state.canUndo);
  const canRedo = useResumeEditorStore((state) => state.canRedo);
  const isDirty = useResumeEditorStore((state) => state.isDirty);
  const ackRevision = useResumeEditorStore((state) => state.ackRevision);
  const beginHistoryGroup = useResumeEditorStore((state) => state.beginHistoryGroup);
  const endHistoryGroup = useResumeEditorStore((state) => state.endHistoryGroup);
  const [leftOpen, setLeftOpen] = useState(true);
  const [rightOpen, setRightOpen] = useState(true);
  const [selectedSectionId, setSelectedSectionId] = useState(resumeDocument.moduleOrder[0] ?? '');
  const [announcement, setAnnouncement] = useState('');
  const [draggedSectionId, setDraggedSectionId] = useState<string | null>(null);
  const [customTitle, setCustomTitle] = useState('');
  const actionRefs = useRef(new Map<string, HTMLButtonElement>());

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
      measurementRootRef.current
        .querySelectorAll<HTMLElement>('[data-render-block-key]')
        .forEach((element) => {
          const key = element.dataset.renderBlockKey;
          if (key) next[key] = { heightPx: element.getBoundingClientRect().height };
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
  }, [flow]);

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
    const media = window.matchMedia('(max-width: 1280px)');
    const collapseForViewport = () => {
      if (media.matches) setRightOpen(false);
    };
    const timer = window.setTimeout(collapseForViewport, 0);
    media.addEventListener('change', collapseForViewport);
    return () => {
      window.clearTimeout(timer);
      media.removeEventListener('change', collapseForViewport);
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
    if (!cloudSaveStatus) return isDirty ? '有未保存修改' : `版本 ${ackRevision}`;
    switch (cloudSaveStatus.phase) {
      case 'synced':
        return localDraftStatus?.phase === 'error'
          ? `云端已保存 · 本地备份不可用 · 版本 ${cloudSaveStatus.revision}`
          : `已保存 · 版本 ${cloudSaveStatus.revision}`;
      case 'saving':
        return '正在保存';
      case 'retry-wait':
        return `保存中断 · 正在准备第 ${String(cloudSaveStatus.attempt)} 次重试`;
      case 'failed':
        return localDraftStatus?.phase === 'error'
          ? '保存失败 · 请导出救援副本'
          : '保存失败 · 已保留本地草稿';
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
    (cloudSaveStatus?.phase === 'failed' && cloudSaveStatus.canRetry);

  return (
    <main
      className={classNames(
        styles.editorShell,
        !leftOpen && styles.leftCollapsed,
        !rightOpen && styles.rightCollapsed,
      )}
    >
      <header className={styles.topbar}>
        <div className={styles.fileIdentity}>
          <span className={styles.eyebrow}>固定测试简历</span>
          <strong>{resume.title}</strong>
        </div>
        <div className={styles.saveStateGroup}>
          <span aria-live="polite" className={styles.saveState} role="status">
            {saveLabel}
          </span>
          {canRetry ? (
            <button className={styles.retryButton} onClick={() => void onRetrySave()} type="button">
              {cloudSaveStatus.phase === 'retry-wait' ? '立即重试' : '重新保存'}
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
            ↶
          </button>
          <button
            aria-label="重做"
            disabled={!canRedo}
            onClick={() => redo()}
            title="重做"
            type="button"
          >
            ↷
          </button>
        </div>
      </header>

      <nav aria-label="简历模块" className={styles.leftRail}>
        <button
          aria-expanded={leftOpen}
          aria-label={leftOpen ? '收起内容面板' : '展开内容面板'}
          className={styles.panelToggle}
          onClick={() => {
            setLeftOpen((value) => !value);
          }}
          title={leftOpen ? '收起内容面板' : '展开内容面板'}
          type="button"
        >
          {leftOpen ? '‹' : '›'}
        </button>
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
                setLeftOpen(true);
              }}
              title={sectionValue.title}
              type="button"
            >
              {moduleGlyph[sectionValue.kind]}
            </button>
          ))}
        </div>
      </nav>

      <aside aria-label="内容编辑" className={styles.leftPanel} hidden={!leftOpen}>
        <div className={styles.panelHeader}>
          <div>
            <span className={styles.eyebrow}>内容</span>
            <h1>{selectedSection?.title ?? '简历内容'}</h1>
          </div>
          <button
            aria-label="收起内容面板"
            className={styles.edgeToggle}
            onClick={() => {
              setLeftOpen(false);
            }}
            type="button"
          >
            ‹
          </button>
        </div>
        {selectedSection ? (
          <section className={styles.sectionEditor}>
            <label>
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
            <div className={styles.sectionSummary}>
              <span>{selectedSection.entries.length} 条内容</span>
              <span>{selectedSection.visible ? '在预览中显示' : '当前已隐藏'}</span>
            </div>
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
              setRightOpen(true);
            }}
            type="button"
          >
            新增模块
          </button>
          <button
            onClick={() => {
              setRightOpen(true);
            }}
            type="button"
          >
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
            <span className={styles.eyebrow}>设置</span>
            <h2>模块布局</h2>
          </div>
          <button
            aria-label="收起设置面板"
            className={styles.edgeToggle}
            onClick={() => {
              setRightOpen(false);
            }}
            type="button"
          >
            ›
          </button>
        </div>
        <p className={styles.helperText}>
          拖动排序，或聚焦拖动按钮后使用上下方向键。隐藏不会删除内容。
        </p>
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
              <button
                className={styles.moduleName}
                onClick={() => {
                  setSelectedSectionId(sectionValue.id);
                  setLeftOpen(true);
                }}
                type="button"
              >
                <span>{sectionValue.title}</span>
                <small>{sectionValue.entries.length} 条</small>
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
            </li>
          ))}
        </ol>
        <div className={styles.customModuleForm}>
          <label htmlFor="custom-module-title">新增自定义模块</label>
          <div>
            <input
              id="custom-module-title"
              maxLength={100}
              onChange={(event) => {
                setCustomTitle(event.target.value);
              }}
              placeholder="例如：开源贡献"
              value={customTitle}
            />
            <button disabled={!customTitle.trim()} onClick={addCustomSection} type="button">
              新增
            </button>
          </div>
        </div>
        <button
          className={styles.restoreButton}
          onClick={restoreDefault}
          ref={(node) => {
            if (node) actionRefs.current.set('layout:restore', node);
            else actionRefs.current.delete('layout:restore');
          }}
          type="button"
        >
          恢复默认顺序与显示
        </button>
        <div aria-label="模块操作通知" aria-live="polite" className={styles.srOnly} role="status">
          {announcement}
        </div>
      </aside>

      <nav aria-label="编辑器工具" className={styles.rightRail}>
        <button
          aria-current="page"
          aria-expanded={rightOpen}
          aria-label={rightOpen ? '收起模块布局设置' : '展开模块布局设置'}
          onClick={() => {
            setRightOpen((value) => !value);
          }}
          title="模块布局"
          type="button"
        >
          布
        </button>
      </nav>
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
