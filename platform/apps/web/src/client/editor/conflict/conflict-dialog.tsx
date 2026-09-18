import type { ResumeDocumentV1 } from '@resume/domain/resume';
import { useEffect, useRef, useState } from 'react';

import type { LocalDraftConflictContext, RemoteResumeSnapshot } from '../persistence';
import { buildThreeWayConflictChanges, type ConflictChangeKind } from './three-way-diff';
import styles from '../editor-workspace.module.css';

const changeLabels: Record<ConflictChangeKind, string> = {
  'local-only': '仅本地修改',
  'remote-only': '仅服务器修改',
  'same-change': '双方修改一致',
  diverged: '双方修改不同',
};

export interface ConflictDialogProps {
  context: LocalDraftConflictContext;
  localDocument: ResumeDocumentV1;
  remote: RemoteResumeSnapshot;
  onAdoptRemote: (remote: RemoteResumeSnapshot) => Promise<void>;
  onClose: () => void;
  onExportLocal: () => void;
  onRebaseLocal: (remote: RemoteResumeSnapshot) => Promise<void>;
}

export function ConflictDialog({
  context,
  localDocument,
  remote,
  onAdoptRemote,
  onClose,
  onExportLocal,
  onRebaseLocal,
}: ConflictDialogProps) {
  const [busyAction, setBusyAction] = useState<'remote' | 'local' | null>(null);
  const [exported, setExported] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const busyActionRef = useRef(busyAction);
  const onCloseRef = useRef(onClose);
  const changes = buildThreeWayConflictChanges(
    context.baseSnapshot,
    localDocument,
    remote.document,
  );

  useEffect(() => {
    busyActionRef.current = busyAction;
    onCloseRef.current = onClose;
  }, [busyAction, onClose]);

  useEffect(() => {
    const previouslyFocused = document.activeElement;
    closeRef.current?.focus();
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && busyActionRef.current === null) onCloseRef.current();
      if (event.key !== 'Tab') return;
      const controls = dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      );
      if (!controls || controls.length === 0) return;
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => {
      window.removeEventListener('keydown', closeOnEscape);
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  const exportLocal = () => {
    onExportLocal();
    setExported(true);
  };
  const adoptRemote = async () => {
    exportLocal();
    setBusyAction('remote');
    try {
      await onAdoptRemote(remote);
    } finally {
      setBusyAction(null);
    }
  };
  const rebaseLocal = async () => {
    setBusyAction('local');
    try {
      await onRebaseLocal(remote);
    } finally {
      setBusyAction(null);
    }
  };

  return (
    <div className={styles.dialogBackdrop}>
      <section
        aria-describedby="save-conflict-description"
        aria-labelledby="save-conflict-title"
        aria-modal="true"
        className={styles.conflictDialog}
        ref={dialogRef}
        role="dialog"
      >
        <header className={styles.conflictHeader}>
          <div>
            <span className={styles.eyebrow}>保存已暂停</span>
            <h2 id="save-conflict-title">检测到服务器版本冲突</h2>
          </div>
          <button
            aria-label="关闭冲突处理"
            disabled={busyAction !== null}
            onClick={onClose}
            ref={closeRef}
            type="button"
          >
            ×
          </button>
        </header>
        <p className={styles.conflictDescription} id="save-conflict-description">
          你的修改基于版本 {context.baseRevision}，服务器当前为版本 {remote.revision}
          。系统没有覆盖任何一方，自动保存会保持暂停，直到你明确选择处理方式。
        </p>
        <div className={styles.conflictVersions}>
          <span>基线 {context.baseRevision}</span>
          <span>本地未保存</span>
          <span>服务器 {remote.revision}</span>
        </div>
        <div className={styles.conflictChanges}>
          <h3>变更概览</h3>
          {changes.length > 0 ? (
            <ul>
              {changes.map((change) => (
                <li data-kind={change.kind} key={change.key}>
                  <span>{change.label}</span>
                  <small>{changeLabels[change.kind]}</small>
                </li>
              ))}
            </ul>
          ) : (
            <p>两边内容目前一致，可以安全采用服务器版本。</p>
          )}
        </div>
        <div className={styles.conflictNotice}>
          “采用服务器版本”会先下载本地救援副本；“以服务器为基线重试”会把当前完整本地快照作为一次新保存提交，再次发生冲突时仍会暂停。
        </div>
        <footer className={styles.conflictActions}>
          <button disabled={busyAction !== null} onClick={exportLocal} type="button">
            {exported ? '本地副本已导出' : '导出本地副本'}
          </button>
          <button disabled={busyAction !== null} onClick={() => void adoptRemote()} type="button">
            {busyAction === 'remote' ? '正在采用…' : '保全本地并采用服务器版本'}
          </button>
          <button
            className={styles.conflictPrimaryAction}
            disabled={busyAction !== null}
            onClick={() => void rebaseLocal()}
            type="button"
          >
            {busyAction === 'local' ? '正在重新保存…' : '以服务器为基线重试本地修改'}
          </button>
        </footer>
      </section>
    </div>
  );
}
