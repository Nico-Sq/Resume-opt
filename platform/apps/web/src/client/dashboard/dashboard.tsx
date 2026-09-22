'use client';

import Link from 'next/link';
import {
  type ReactNode,
  type SyntheticEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { z } from 'zod';

import { AccountExitBarrier } from '../account/account-exit-barrier';
import {
  DexieLocalDraftRepository,
  hasUnsyncedLocalChanges,
  type LocalDraftRecord,
} from '../editor/persistence';
import { publishResumeDeleted } from '../resume-lifecycle-channel';
import styles from './dashboard.module.css';

const StageSchema = z.enum(['student', 'employed', 'transition']);
const ResumeMetaSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  locale: z.string(),
  stage: StageSchema,
  revision: z.string(),
  templateId: z.string(),
  templateVersion: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
const ListResponseSchema = z.object({
  data: z.object({ items: z.array(ResumeMetaSchema), nextCursor: z.string().nullable() }),
});
const ResumeIdResponseSchema = z.object({ data: z.object({ id: z.uuid() }) });
const RenameResponseSchema = z.object({ data: z.object({ resume: ResumeMetaSchema }) });
const CsrfResponseSchema = z.object({ data: z.object({ csrfToken: z.string().min(1) }) });

type ResumeMeta = z.infer<typeof ResumeMetaSchema>;
type Stage = z.infer<typeof StageSchema>;
export type IconName = 'arrow' | 'briefcase' | 'copy' | 'document' | 'edit' | 'plus' | 'trash';

interface PrivatePageProps {
  userId: string;
  displayName: string;
  csrfRequired: boolean;
}

interface CreateResumePageProps extends PrivatePageProps {
  navigate?: (path: string) => void;
}

const stageLabels: Record<Stage, string> = {
  student: '在校 / 应届',
  employed: '在职',
  transition: '待业',
};

export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    arrow: <path d="m9 18 6-6-6-6m6 6H3" />,
    briefcase: <path d="M9 6V4h6v2m-11 4h16v9H4zm0 0V7h16v3m-9 3h2" />,
    copy: <path d="M8 8h11v11H8zM5 16H4V5h11v1" />,
    document: <path d="M6 3h8l4 4v14H6zm8 0v5h4M9 13h6m-6 4h6" />,
    edit: <path d="m4 20 4-1 10-10-3-3L5 16zm9-12 3 3" />,
    plus: <path d="M12 5v14M5 12h14" />,
    trash: <path d="M5 7h14m-9-3h4l1 3M8 10v8m4-8v8m4-8v8M7 7l1 14h8l1-14" />,
  };
  return (
    <svg aria-hidden="true" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
        {paths[name]}
      </g>
    </svg>
  );
}

export function AppHeader({
  displayName,
  accountActions,
  active = 'resumes',
}: {
  displayName: string;
  accountActions?: ReactNode;
  active?: 'resumes' | 'trash';
}) {
  return (
    <header className={styles.header}>
      <Link className={styles.brand} href="/resumes">
        <Icon name="document" />
        <span>简历工作台</span>
      </Link>
      <nav aria-label="主导航" className={styles.nav}>
        <Link aria-current={active === 'resumes' ? 'page' : undefined} href="/resumes">
          我的简历
        </Link>
        <Link aria-current={active === 'trash' ? 'page' : undefined} href="/resumes/trash">
          最近删除
        </Link>
      </nav>
      <div className={styles.account}>
        <span className={styles.avatar} aria-hidden="true">
          {Array.from(displayName.trim())[0] ?? '用'}
        </span>
        <span className={styles.accountName}>{displayName}</span>
        {accountActions}
      </div>
    </header>
  );
}

function Modal({
  children,
  labelId,
  onClose,
}: {
  children: ReactNode;
  labelId: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else dialog.setAttribute('open', '');
    return () => {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    };
  }, []);
  return (
    <dialog
      aria-labelledby={labelId}
      className={styles.dialog}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      ref={ref}
    >
      {children}
    </dialog>
  );
}

function formatUpdatedAt(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function copyTitle(title: string) {
  return `${Array.from(title).slice(0, 197).join('')} 副本`;
}

function downloadJson(contents: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function visibleError(response: Response, fallback: string) {
  if (response.status === 401) return '登录状态已失效，请重新登录。';
  if (response.status === 412) return '简历已在其他位置更新，请刷新列表后重试。';
  if (response.status === 409) return '请求状态无法确认，请使用原操作重试。';
  if (response.status === 422) return '输入内容不符合要求，请检查后重试。';
  return fallback;
}

export function ResumeDashboard({ userId, displayName, csrfRequired }: PrivatePageProps) {
  const [items, setItems] = useState<ResumeMeta[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listMessage, setListMessage] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [renameTarget, setRenameTarget] = useState<ResumeMeta | null>(null);
  const [renameTitle, setRenameTitle] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<ResumeMeta | null>(null);
  const [actionMessage, setActionMessage] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [exitState, setExitState] = useState<
    | { phase: 'idle' }
    | { phase: 'preparing' }
    | { phase: 'decision'; rescueJson: string; unsyncedCount: number }
    | { phase: 'error'; message: string }
  >({ phase: 'idle' });
  const csrfTokenRef = useRef<string | undefined>(undefined);
  const retryKeys = useRef(new Map<string, string>());
  const createButtonRef = useRef<HTMLAnchorElement>(null);
  const exitBarrierRef = useRef<AccountExitBarrier | null>(null);
  const draftRepositoryRef = useRef<DexieLocalDraftRepository | null>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`/api/v1/resumes?${query.toString()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error(visibleError(response, '暂时无法加载简历列表。'));
    return ListResponseSchema.parse(await response.json()).data;
  }, []);

  const reload = useCallback(() => {
    setPhase('loading');
    setListMessage('');
    void loadPage().then(
      (page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setPhase('ready');
      },
      (error: unknown) => {
        setListMessage(error instanceof Error ? error.message : '暂时无法加载简历列表。');
        setPhase('error');
      },
    );
  }, [loadPage]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!csrfRequired) return;
    const repository = new DexieLocalDraftRepository();
    draftRepositoryRef.current = repository;
    try {
      const barrier = new AccountExitBarrier({
        userId,
        onPrepare: () => Promise.resolve(),
        onCancel: () => {
          window.location.reload();
        },
        onComplete: () => {
          window.location.replace('/login');
        },
      });
      exitBarrierRef.current = barrier;
      return () => {
        exitBarrierRef.current = null;
        barrier.dispose();
        repository.close();
        draftRepositoryRef.current = null;
      };
    } catch (error) {
      queueMicrotask(() => {
        setExitState({
          phase: 'error',
          message: error instanceof Error ? error.message : '当前浏览器无法安全退出账户。',
        });
      });
      return () => {
        repository.close();
        draftRepositoryRef.current = null;
      };
    }
  }, [csrfRequired, userId]);

  const csrfToken = async () => {
    if (!csrfRequired) return undefined;
    if (csrfTokenRef.current) return csrfTokenRef.current;
    const response = await fetch('/api/v1/csrf', {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('操作凭据暂时无法获取。');
    const token = CsrfResponseSchema.parse(await response.json()).data.csrfToken;
    csrfTokenRef.current = token;
    return token;
  };

  const keyFor = (operation: string, item: ResumeMeta, detail = '') => {
    const scope = `${operation}:${item.id}:${item.revision}:${detail}`;
    const existing = retryKeys.current.get(scope);
    if (existing) return existing;
    const key = crypto.randomUUID();
    retryKeys.current.set(scope, key);
    return key;
  };

  const writeHeaders = async (idempotencyKey: string, revision?: string) => {
    const token = await csrfToken();
    return {
      'Content-Type': 'application/json',
      'Idempotency-Key': idempotencyKey,
      ...(revision ? { 'If-Match': `"${revision}"` } : {}),
      ...(token ? { 'X-CSRF-Token': token } : {}),
    };
  };

  const rename = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!renameTarget) return;
    const title = renameTitle.trim();
    const key = keyFor('rename', renameTarget, title);
    setBusyAction(`rename:${renameTarget.id}`);
    setActionMessage('');
    try {
      const response = await fetch(`/api/v1/resumes/${renameTarget.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: await writeHeaders(key, renameTarget.revision),
        body: JSON.stringify({ title }),
      });
      if (!response.ok) throw new Error(visibleError(response, '重命名失败，原卡片已保留。'));
      const updated = RenameResponseSchema.parse(await response.json()).data.resume;
      setItems((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      retryKeys.current.delete(`rename:${renameTarget.id}:${renameTarget.revision}:${title}`);
      setRenameTarget(null);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : '重命名失败，原卡片已保留。');
    } finally {
      setBusyAction(null);
    }
  };

  const copy = async (item: ResumeMeta) => {
    const title = copyTitle(item.title);
    const key = keyFor('copy', item, title);
    setBusyAction(`copy:${item.id}`);
    setActionMessage('');
    try {
      const response = await fetch(`/api/v1/resumes/${item.id}/copies`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: await writeHeaders(key),
        body: JSON.stringify({ sourceRevision: item.revision, title }),
      });
      if (!response.ok) throw new Error(visibleError(response, '复制失败，原卡片已保留。'));
      ResumeIdResponseSchema.parse(await response.json());
      const page = await loadPage();
      setItems(page.items);
      setNextCursor(page.nextCursor);
      retryKeys.current.delete(`copy:${item.id}:${item.revision}:${title}`);
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : '复制失败，原卡片已保留。');
    } finally {
      setBusyAction(null);
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    const key = keyFor('delete', deleteTarget);
    setBusyAction(`delete:${deleteTarget.id}`);
    setActionMessage('');
    try {
      const response = await fetch(`/api/v1/resumes/${deleteTarget.id}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: await writeHeaders(key, deleteTarget.revision),
        body: JSON.stringify({ confirm: true }),
      });
      if (!response.ok) throw new Error(visibleError(response, '删除失败，原卡片已保留。'));
      setItems((current) => current.filter((item) => item.id !== deleteTarget.id));
      publishResumeDeleted(userId, deleteTarget.id);
      retryKeys.current.delete(`delete:${deleteTarget.id}:${deleteTarget.revision}:`);
      setDeleteTarget(null);
      queueMicrotask(() => createButtonRef.current?.focus());
    } catch (error) {
      setActionMessage(error instanceof Error ? error.message : '删除失败，原卡片已保留。');
    } finally {
      setBusyAction(null);
    }
  };

  const inspectDrafts = async () => {
    const repository = draftRepositoryRef.current;
    if (!repository) throw new Error('本地草稿存储不可用。');
    const rescueJson = await repository.exportAccountRescue(userId);
    const payload = JSON.parse(rescueJson) as { drafts: LocalDraftRecord[] };
    return {
      rescueJson,
      unsyncedCount: payload.drafts.filter(hasUnsyncedLocalChanges).length,
    };
  };

  const finishExit = async (rescueJson?: string) => {
    const barrier = exitBarrierRef.current;
    const repository = draftRepositoryRef.current;
    if (!barrier || !repository) return;
    setExitState({ phase: 'preparing' });
    try {
      const completed = await barrier.runExclusive(async () => {
        const latest = await inspectDrafts();
        if (latest.unsyncedCount > 0 && !rescueJson) {
          setExitState({ phase: 'decision', ...latest });
          return false;
        }
        if (rescueJson) {
          downloadJson(latest.rescueJson, `resume-account-${userId}-drafts.json`);
        }
        const response = await fetch('/api/auth/sign-out', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        });
        if (!response.ok) throw new Error('服务端尚未确认退出');
        await repository.clearAccount(userId, { rescueConfirmed: true });
        return true;
      });
      if (completed) barrier.complete();
    } catch {
      setExitState({
        phase: 'error',
        message: '退出尚未完成，会话或本地草稿清理未确认；草稿仍被保留。',
      });
    }
  };

  const beginExit = async () => {
    const barrier = exitBarrierRef.current;
    if (!barrier) {
      setExitState({ phase: 'error', message: '当前浏览器无法安全协调多标签页退出。' });
      return;
    }
    setExitState({ phase: 'preparing' });
    try {
      const inspection = await barrier.runExclusive(inspectDrafts);
      if (inspection.unsyncedCount > 0) setExitState({ phase: 'decision', ...inspection });
      else await finishExit();
    } catch {
      setExitState({ phase: 'error', message: '未能确认所有编辑标签页已暂停，账户没有退出。' });
    }
  };

  return (
    <div className={styles.page}>
      <AppHeader
        accountActions={
          csrfRequired ? (
            <details className={styles.accountMenu}>
              <summary aria-label="打开账户菜单">⌄</summary>
              <div>
                <button onClick={() => void beginExit()} type="button">
                  退出登录
                </button>
              </div>
            </details>
          ) : (
            <span className={styles.devBadge}>开发模式</span>
          )
        }
        displayName={displayName}
      />
      <main className={styles.main}>
        <div className={styles.titleRow}>
          <div>
            <h1>我的简历</h1>
            <p>管理你的简历版本，并继续最近的编辑</p>
          </div>
          <Link className={styles.primaryButton} href="/resumes/new" ref={createButtonRef}>
            <Icon name="plus" />
            新建简历
          </Link>
        </div>

        {phase === 'loading' ? (
          <section aria-busy="true" aria-label="正在加载简历" className={styles.skeletonList}>
            {[0, 1, 2].map((item) => (
              <div className={styles.skeleton} key={item} />
            ))}
          </section>
        ) : null}
        {phase === 'error' ? (
          <section className={styles.statePanel} role="alert">
            <Icon name="document" size={52} />
            <h2>暂时无法加载简历</h2>
            <p>{listMessage}</p>
            <button className={styles.primaryButton} onClick={reload} type="button">
              重新加载
            </button>
          </section>
        ) : null}
        {phase === 'ready' && items.length === 0 ? (
          <section className={styles.statePanel}>
            <Icon name="document" size={72} />
            <h2>创建你的第一份简历</h2>
            <p>从真实经历开始填写，内容会保存在你的账户中。</p>
            <Link className={styles.primaryButton} href="/resumes/new">
              创建简历
            </Link>
            <ol className={styles.steps}>
              <li>
                <span>1</span>填写真实经历
              </li>
              <li>
                <span>2</span>编辑并自动保存
              </li>
              <li>
                <span>3</span>预览简历版式
              </li>
            </ol>
          </section>
        ) : null}
        {phase === 'ready' && items.length > 0 ? (
          <section aria-labelledby="recent-title" className={styles.resumeSection}>
            <div className={styles.sectionHeading}>
              <h2 id="recent-title">最近编辑</h2>
              <span>{items.length} 份简历</span>
            </div>
            {actionMessage && !renameTarget && !deleteTarget ? (
              <p className={styles.inlineError} role="alert">
                {actionMessage}
              </p>
            ) : null}
            <div className={styles.resumeList}>
              {items.map((item) => (
                <article className={styles.resumeCard} data-resume-id={item.id} key={item.id}>
                  <Link
                    aria-label={`编辑${item.title}`}
                    className={styles.documentTile}
                    href={`/resumes/${item.id}/edit`}
                  >
                    <Icon name="document" size={34} />
                  </Link>
                  <div className={styles.resumeInfo}>
                    <Link href={`/resumes/${item.id}/edit`}>{item.title}</Link>
                    <p>
                      <Icon name="briefcase" size={17} />
                      {stageLabels[item.stage]}
                    </p>
                    <small>最近编辑于 {formatUpdatedAt(item.updatedAt)}</small>
                  </div>
                  <div className={styles.cardActions}>
                    <Link className={styles.secondaryButton} href={`/resumes/${item.id}/edit`}>
                      <Icon name="edit" />
                      编辑
                    </Link>
                    <button
                      className={styles.secondaryButton}
                      disabled={busyAction === `copy:${item.id}`}
                      onClick={() => void copy(item)}
                      type="button"
                    >
                      <Icon name="copy" />
                      {busyAction === `copy:${item.id}` ? '复制中' : '复制'}
                    </button>
                    <button
                      className={styles.secondaryButton}
                      onClick={() => {
                        setActionMessage('');
                        setRenameTitle(item.title);
                        setRenameTarget(item);
                      }}
                      type="button"
                    >
                      <Icon name="edit" />
                      重命名
                    </button>
                    <button
                      className={styles.dangerButton}
                      onClick={() => {
                        setActionMessage('');
                        setDeleteTarget(item);
                      }}
                      type="button"
                    >
                      <Icon name="trash" />
                      删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
            <footer className={styles.listFooter}>
              <span>已显示 {items.length} 份简历</span>
              {nextCursor ? (
                <button
                  className={styles.secondaryButton}
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    setListMessage('');
                    void loadPage(nextCursor).then(
                      (page) => {
                        setItems((current) => [...current, ...page.items]);
                        setNextCursor(page.nextCursor);
                        setLoadingMore(false);
                      },
                      (error: unknown) => {
                        setListMessage(
                          error instanceof Error ? error.message : '下一页暂时无法加载。',
                        );
                        setLoadingMore(false);
                      },
                    );
                  }}
                  type="button"
                >
                  {loadingMore ? '加载中' : '加载更多'}
                </button>
              ) : null}
            </footer>
            {listMessage ? (
              <p className={styles.inlineError} role="alert">
                {listMessage}
              </p>
            ) : null}
          </section>
        ) : null}
      </main>

      {renameTarget ? (
        <Modal
          labelId="rename-title"
          onClose={() => {
            if (!busyAction) setRenameTarget(null);
          }}
        >
          <form onSubmit={(event) => void rename(event)}>
            <h2 id="rename-title">重命名简历</h2>
            <p>名称修改会作为新版本保存，不会改变正文。</p>
            <label className={styles.field}>
              简历名称
              <input
                autoFocus
                onChange={(event) => {
                  setRenameTitle(event.currentTarget.value);
                }}
                value={renameTitle}
              />
            </label>
            {actionMessage ? (
              <p className={styles.inlineError} role="alert">
                {actionMessage}
              </p>
            ) : null}
            <div className={styles.dialogActions}>
              <button
                disabled={Boolean(busyAction)}
                onClick={() => {
                  setRenameTarget(null);
                }}
                type="button"
              >
                取消
              </button>
              <button className={styles.primaryButton} disabled={Boolean(busyAction)} type="submit">
                {busyAction ? '保存中' : '保存名称'}
              </button>
            </div>
          </form>
        </Modal>
      ) : null}

      {deleteTarget ? (
        <Modal
          labelId="delete-title"
          onClose={() => {
            if (!busyAction) setDeleteTarget(null);
          }}
        >
          <h2 id="delete-title">删除“{deleteTarget.title}”？</h2>
          <p>删除后会从工作台消失，并可在 7 天内从最近删除中恢复。</p>
          {actionMessage ? (
            <p className={styles.inlineError} role="alert">
              {actionMessage}
            </p>
          ) : null}
          <div className={styles.dialogActions}>
            <button
              disabled={Boolean(busyAction)}
              onClick={() => {
                setDeleteTarget(null);
              }}
              type="button"
            >
              取消
            </button>
            <button
              className={styles.confirmDanger}
              disabled={Boolean(busyAction)}
              onClick={() => void remove()}
              type="button"
            >
              {busyAction ? '删除中' : '确认删除'}
            </button>
          </div>
        </Modal>
      ) : null}

      {exitState.phase !== 'idle' ? (
        <Modal
          labelId="exit-title"
          onClose={() => {
            if (exitState.phase !== 'preparing') {
              exitBarrierRef.current?.cancel();
            }
          }}
        >
          <h2 id="exit-title">
            {exitState.phase === 'preparing'
              ? '正在安全退出'
              : exitState.phase === 'decision'
                ? '退出前处理本地修改'
                : '尚未完成退出'}
          </h2>
          <p>
            {exitState.phase === 'preparing'
              ? '正在等待编辑标签页停止上传，并检查本地草稿。'
              : exitState.phase === 'decision'
                ? `发现 ${String(exitState.unsyncedCount)} 份未同步草稿。请先返回编辑，或下载救援副本后退出。`
                : exitState.message}
          </p>
          {exitState.phase !== 'preparing' ? (
            <div className={styles.dialogActions}>
              <button
                onClick={() => {
                  exitBarrierRef.current?.cancel();
                }}
                type="button"
              >
                取消退出
              </button>
              {exitState.phase === 'decision' ? (
                <button
                  className={styles.primaryButton}
                  onClick={() => void finishExit(exitState.rescueJson)}
                  type="button"
                >
                  下载救援并退出
                </button>
              ) : (
                <button
                  className={styles.primaryButton}
                  onClick={() => void beginExit()}
                  type="button"
                >
                  重新检查
                </button>
              )}
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}

export function CreateResumePage({ displayName, csrfRequired, navigate }: CreateResumePageProps) {
  const [title, setTitle] = useState('我的简历');
  const [stage, setStage] = useState<Stage>('employed');
  const [mode, setMode] = useState<'blank' | 'basic-template'>('blank');
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const requestKeyRef = useRef<string | undefined>(undefined);
  const csrfTokenRef = useRef<string | undefined>(undefined);

  const change = (work: () => void) => {
    requestKeyRef.current = undefined;
    setMessage('');
    work();
  };

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (Array.from(normalizedTitle).length < 1 || Array.from(normalizedTitle).length > 200) {
      setMessage('简历名称需为 1—200 个字符。');
      return;
    }
    requestKeyRef.current ??= crypto.randomUUID();
    setPending(true);
    setMessage('');
    try {
      if (csrfRequired && !csrfTokenRef.current) {
        const csrfResponse = await fetch('/api/v1/csrf', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!csrfResponse.ok) throw new Error('创建凭据暂时无法获取。');
        csrfTokenRef.current = CsrfResponseSchema.parse(await csrfResponse.json()).data.csrfToken;
      }
      const response = await fetch('/api/v1/resumes', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': requestKeyRef.current,
          ...(csrfTokenRef.current ? { 'X-CSRF-Token': csrfTokenRef.current } : {}),
        },
        body: JSON.stringify({ title: normalizedTitle, stage, mode }),
      });
      if (!response.ok) {
        throw new Error(visibleError(response, '创建失败，输入已保留，请使用原请求重试。'));
      }
      const resume = ResumeIdResponseSchema.parse(await response.json()).data;
      const destination = `/resumes/${resume.id}/edit`;
      if (navigate) navigate(destination);
      else window.location.replace(destination);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '创建失败，输入已保留。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.page}>
      <AppHeader displayName={displayName} />
      <main className={styles.createMain}>
        <Link className={styles.backLink} href="/resumes">
          ← 返回我的简历
        </Link>
        <div className={styles.createTitle}>
          <h1>创建简历</h1>
          <p>选择创建方式并填写基础信息，稍后可在编辑器中继续调整</p>
        </div>
        <form className={styles.createCard} onSubmit={(event) => void submit(event)}>
          <section className={styles.modePanel}>
            <h2>创建方式</h2>
            <p>选择一个开始方式</p>
            <label className={mode === 'blank' ? styles.modeSelected : styles.modeOption}>
              <input
                checked={mode === 'blank'}
                name="mode"
                onChange={() => {
                  change(() => {
                    setMode('blank');
                  });
                }}
                type="radio"
                value="blank"
              />
              <Icon name="document" size={32} />
              <span>
                <strong>空白创建</strong>
                <small>从默认模块开始填写</small>
              </span>
            </label>
            <label className={mode === 'basic-template' ? styles.modeSelected : styles.modeOption}>
              <input
                checked={mode === 'basic-template'}
                name="mode"
                onChange={() => {
                  change(() => {
                    setMode('basic-template');
                  });
                }}
                type="radio"
                value="basic-template"
              />
              <Icon name="document" size={32} />
              <span>
                <strong>基础模板</strong>
                <small>使用现有简洁单栏样式</small>
              </span>
            </label>
            <p className={styles.modeNote}>创建方式只影响初始模块，不限制后续编辑。</p>
          </section>
          <section className={styles.detailsPanel}>
            <h2>基础信息</h2>
            <p>这些信息用于创建初始简历，之后仍可修改</p>
            <label className={styles.field}>
              简历名称
              <input
                autoFocus
                onChange={(event) => {
                  change(() => {
                    setTitle(event.currentTarget.value);
                  });
                }}
                value={title}
              />
            </label>
            <fieldset className={styles.stageFieldset}>
              <legend>用户阶段</legend>
              <div>
                {(Object.entries(stageLabels) as Array<[Stage, string]>).map(([value, label]) => (
                  <label key={value}>
                    <input
                      checked={stage === value}
                      name="stage"
                      onChange={() => {
                        change(() => {
                          setStage(value);
                        });
                      }}
                      type="radio"
                      value={value}
                    />
                    <span>{label}</span>
                  </label>
                ))}
              </div>
              <small>只设置默认模块组合，不限制后续添加内容。</small>
            </fieldset>
            <div className={styles.templateSummary}>
              <Icon name="document" size={38} />
              <div>
                <span>初始模板</span>
                <strong>简洁单栏</strong>
                <small>适合中文技术与产品岗位</small>
              </div>
            </div>
            {message ? (
              <p className={styles.inlineError} role="alert">
                {message}
              </p>
            ) : null}
          </section>
          <footer className={styles.createFooter}>
            <span>🔒 简历默认仅自己可见</span>
            <div>
              <Link className={styles.secondaryButton} href="/resumes">
                取消
              </Link>
              <button className={styles.primaryButton} disabled={pending} type="submit">
                {pending ? '正在创建' : '创建并进入编辑器'}
                <Icon name="arrow" />
              </button>
            </div>
          </footer>
        </form>
      </main>
    </div>
  );
}
