'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { AppHeader, Icon } from './dashboard';
import styles from './dashboard.module.css';

const DeletedResumeSchema = z.object({
  id: z.uuid(),
  title: z.string(),
  locale: z.string(),
  stage: z.enum(['student', 'employed', 'transition']),
  revision: z.string(),
  templateId: z.string(),
  templateVersion: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  deletedAt: z.iso.datetime(),
  restoreUntil: z.iso.datetime(),
});
const TrashResponseSchema = z.object({
  data: z.object({ items: z.array(DeletedResumeSchema), nextCursor: z.string().nullable() }),
});
const CsrfResponseSchema = z.object({ data: z.object({ csrfToken: z.string().min(1) }) });
const RestoreResponseSchema = z.object({
  data: z.object({ resume: z.object({ id: z.uuid(), revision: z.string() }) }),
});

type DeletedResume = z.infer<typeof DeletedResumeSchema>;

const stageLabels: Record<DeletedResume['stage'], string> = {
  student: '在校 / 应届',
  employed: '在职',
  transition: '待业',
};

function deadlineLabel(value: string, now = Date.now()) {
  const remainingHours = Math.ceil((new Date(value).getTime() - now) / 3_600_000);
  if (remainingHours <= 0) return '恢复期限已过';
  if (remainingHours <= 24) return `${String(remainingHours)} 小时内可恢复`;
  return `${String(Math.ceil(remainingHours / 24))} 天内可恢复`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function restoreError(response: Response) {
  if (response.status === 410) return '恢复期限已过，无法恢复。';
  if (response.status === 412) return '删除状态已变化，请刷新后重试。';
  if (response.status === 401) return '登录状态已失效，请重新登录。';
  if (response.status === 409) return '请求状态无法确认，请使用原操作重试。';
  return '恢复失败，简历仍保留在最近删除中。';
}

export function TrashPage({
  displayName,
  csrfRequired,
}: {
  userId: string;
  displayName: string;
  csrfRequired: boolean;
}) {
  const [items, setItems] = useState<DeletedResume[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [referenceTime] = useState(Date.now);
  const csrfTokenRef = useRef<string | undefined>(undefined);
  const retryKeys = useRef(new Map<string, string>());
  const buttonRefs = useRef(new Map<string, HTMLButtonElement>());
  const titleRef = useRef<HTMLHeadingElement>(null);

  const loadPage = useCallback(async (cursor?: string) => {
    const query = new URLSearchParams({ limit: '20' });
    if (cursor) query.set('cursor', cursor);
    const response = await fetch(`/api/v1/resumes/trash?${query.toString()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
    });
    if (!response.ok) throw new Error('暂时无法加载最近删除。');
    return TrashResponseSchema.parse(await response.json()).data;
  }, []);

  const reload = useCallback(() => {
    setPhase('loading');
    setMessage('');
    void loadPage().then(
      (page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setPhase('ready');
      },
      (error: unknown) => {
        setMessage(error instanceof Error ? error.message : '暂时无法加载最近删除。');
        setPhase('error');
      },
    );
  }, [loadPage]);

  useEffect(() => {
    void loadPage().then(
      (page) => {
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setPhase('ready');
      },
      (error: unknown) => {
        setMessage(error instanceof Error ? error.message : '暂时无法加载最近删除。');
        setPhase('error');
      },
    );
  }, [loadPage]);

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

  const restore = async (item: DeletedResume) => {
    if (new Date(item.restoreUntil).getTime() <= referenceTime) return;
    const scope = `${item.id}:${item.revision}`;
    const key = retryKeys.current.get(scope) ?? crypto.randomUUID();
    retryKeys.current.set(scope, key);
    setBusyId(item.id);
    setMessage('');
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/v1/resumes/${item.id}/undelete`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'If-Match': `"${item.revision}"`,
          ...(token ? { 'X-CSRF-Token': token } : {}),
        },
        body: '{}',
      });
      if (!response.ok) throw new Error(restoreError(response));
      RestoreResponseSchema.parse(await response.json());
      retryKeys.current.delete(scope);
      const index = items.findIndex((candidate) => candidate.id === item.id);
      const remaining = items.filter((candidate) => candidate.id !== item.id);
      const focusOrder = [
        ...remaining.slice(Math.min(index, remaining.length)),
        ...remaining.slice(0, Math.min(index, remaining.length)),
      ];
      const nextFocus = focusOrder.find(
        (candidate) => new Date(candidate.restoreUntil).getTime() > referenceTime,
      )?.id;
      setItems(remaining);
      setMessage(`“${item.title}”已恢复到我的简历。`);
      queueMicrotask(() => {
        if (nextFocus) buttonRefs.current.get(nextFocus)?.focus();
        else titleRef.current?.focus();
      });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '恢复失败，简历仍保留在最近删除中。');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className={styles.page}>
      <AppHeader active="trash" displayName={displayName} />
      <main className={styles.main}>
        <div className={styles.titleRow}>
          <div>
            <Link className={styles.backLink} href="/resumes">
              ← 返回我的简历
            </Link>
            <h1 ref={titleRef} tabIndex={-1}>
              最近删除
            </h1>
            <p>简历删除后保留 7 天，到期后将进入清理流程。</p>
          </div>
        </div>

        {phase === 'loading' ? (
          <section aria-busy="true" aria-label="正在加载最近删除" className={styles.skeletonList}>
            {[0, 1].map((item) => (
              <div className={styles.skeleton} key={item} />
            ))}
          </section>
        ) : null}
        {phase === 'error' ? (
          <section className={styles.statePanel} role="alert">
            <Icon name="trash" size={52} />
            <h2>暂时无法加载最近删除</h2>
            <p>{message}</p>
            <button className={styles.primaryButton} onClick={reload} type="button">
              重新加载
            </button>
          </section>
        ) : null}
        {phase === 'ready' && message ? (
          <p aria-live="polite" className={styles.inlineMessage} role="status">
            {message}
          </p>
        ) : null}
        {phase === 'ready' && items.length === 0 ? (
          <section className={styles.statePanel}>
            <Icon name="trash" size={64} />
            <h2>最近删除为空</h2>
            <p>删除的简历会在这里保留 7 天；这里不会展示简历正文。</p>
            <Link className={styles.primaryButton} href="/resumes">
              返回我的简历
            </Link>
          </section>
        ) : null}
        {phase === 'ready' && items.length > 0 ? (
          <section aria-labelledby="trash-list-title" className={styles.resumeSection}>
            <div className={styles.sectionHeading}>
              <h2 id="trash-list-title">可恢复的简历</h2>
              <span>{items.length} 份</span>
            </div>
            <div className={styles.resumeList}>
              {items.map((item) => {
                const expired = new Date(item.restoreUntil).getTime() <= referenceTime;
                return (
                  <article className={styles.resumeCard} data-resume-id={item.id} key={item.id}>
                    <div aria-hidden="true" className={styles.documentTile}>
                      <Icon name="trash" size={32} />
                    </div>
                    <div className={styles.resumeInfo}>
                      <strong>{item.title}</strong>
                      <p>{stageLabels[item.stage]}</p>
                      <small>删除于 {formatDate(item.deletedAt)}</small>
                      <small className={expired ? styles.expiredText : undefined}>
                        {deadlineLabel(item.restoreUntil, referenceTime)} · 截止{' '}
                        {formatDate(item.restoreUntil)}
                      </small>
                    </div>
                    <div className={styles.cardActions}>
                      <button
                        className={styles.secondaryButton}
                        disabled={expired || busyId === item.id}
                        onClick={() => void restore(item)}
                        ref={(button) => {
                          if (button) buttonRefs.current.set(item.id, button);
                          else buttonRefs.current.delete(item.id);
                        }}
                        type="button"
                      >
                        {busyId === item.id ? '恢复中' : expired ? '已过期' : '恢复'}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <footer className={styles.listFooter}>
              <span>只显示元数据，不读取已删除正文</span>
              {nextCursor ? (
                <button
                  className={styles.secondaryButton}
                  disabled={loadingMore}
                  onClick={() => {
                    setLoadingMore(true);
                    setMessage('');
                    void loadPage(nextCursor).then(
                      (page) => {
                        setItems((current) => [...current, ...page.items]);
                        setNextCursor(page.nextCursor);
                        setLoadingMore(false);
                      },
                      () => {
                        setMessage('下一页暂时无法加载，现有列表已保留。');
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
          </section>
        ) : null}
      </main>
    </div>
  );
}
