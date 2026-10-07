'use client';

import Link from 'next/link';
import { type SyntheticEvent, useEffect, useRef, useState } from 'react';
import { z } from 'zod';

import { DexieLocalDraftRepository, hasUnsyncedLocalChanges } from '../editor/persistence';
import { AppHeader } from '../dashboard/dashboard';
import { AccountExitBarrier } from './account-exit-barrier';
import styles from './account-page.module.css';

const CsrfResponseSchema = z.object({ data: z.object({ csrfToken: z.string().min(1) }) });
const AcceptedSchema = z.object({
  data: z.object({
    requestId: z.uuid(),
    status: z.literal('accepted'),
    acceptedAt: z.iso.datetime(),
  }),
});

interface AccountPageProps {
  userId: string;
  displayName: string;
  csrfRequired: boolean;
}

function downloadRescue(contents: string, userId: string) {
  const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `resume-account-${userId}-drafts.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AccountPage({ userId, displayName, csrfRequired }: AccountPageProps) {
  const [password, setPassword] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [rescue, setRescue] = useState<{ json: string; count: number } | null>(null);
  const [rescueConfirmed, setRescueConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const repositoryRef = useRef<DexieLocalDraftRepository | null>(null);
  const barrierRef = useRef<AccountExitBarrier | null>(null);
  const idempotencyKey = useRef<string | null>(null);

  useEffect(() => {
    if (!csrfRequired) return;
    const repository = new DexieLocalDraftRepository();
    repositoryRef.current = repository;
    try {
      barrierRef.current = new AccountExitBarrier({
        userId,
        onPrepare: () => Promise.resolve(),
        onCancel: () => {
          window.location.reload();
        },
        onComplete: () => {
          window.location.replace('/login?accountDeleted=1');
        },
      });
    } catch (error) {
      queueMicrotask(() => {
        setMessage(error instanceof Error ? error.message : '当前浏览器无法安全注销账户。');
      });
    }
    return () => {
      barrierRef.current?.dispose();
      barrierRef.current = null;
      repository.close();
      repositoryRef.current = null;
    };
  }, [csrfRequired, userId]);

  const submit = async (event: SyntheticEvent<HTMLFormElement>) => {
    event.preventDefault();
    const repository = repositoryRef.current;
    const barrier = barrierRef.current;
    if (!csrfRequired || !repository || !barrier || !confirmed || !password) return;
    setPending(true);
    setMessage('');
    try {
      const completed = await barrier.runExclusive(async () => {
        const rescueJson = await repository.exportAccountRescue(userId);
        const drafts = z.object({ drafts: z.array(z.unknown()) }).parse(JSON.parse(rescueJson))
          .drafts as Parameters<typeof hasUnsyncedLocalChanges>[0][];
        const unsyncedCount = drafts.filter(hasUnsyncedLocalChanges).length;
        if (unsyncedCount > 0 && !rescueConfirmed) {
          setRescue({ json: rescueJson, count: unsyncedCount });
          setMessage('请先下载未同步草稿的 JSON 副本，再确认注销。');
          return false;
        }

        const csrfResponse = await fetch('/api/v1/csrf', {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!csrfResponse.ok) throw new Error('操作凭据暂时无法获取。');
        const csrfToken = CsrfResponseSchema.parse(await csrfResponse.json()).data.csrfToken;
        idempotencyKey.current ??= crypto.randomUUID();
        const response = await fetch('/api/v1/account', {
          method: 'DELETE',
          credentials: 'same-origin',
          headers: {
            'Content-Type': 'application/json',
            'Idempotency-Key': idempotencyKey.current,
            'X-CSRF-Token': csrfToken,
          },
          body: JSON.stringify({ confirm: true, password }),
        });
        if (!response.ok) {
          if (response.status === 401)
            throw new Error('密码错误或登录已超过 10 分钟，请重新登录。');
          throw new Error('账户注销暂时无法受理，账户和草稿均未在本机清除。');
        }
        AcceptedSchema.parse(await response.json());
        await repository.clearAccount(userId, { rescueConfirmed: true });
        return true;
      });
      if (completed) barrier.complete();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '账户注销暂时无法受理。');
    } finally {
      setPending(false);
    }
  };

  return (
    <div className={styles.page}>
      <AppHeader displayName={displayName} />
      <main className={styles.main}>
        <Link className={styles.back} href="/resumes">
          ← 返回简历工作台
        </Link>
        <section className={styles.panel}>
          <h1>账户与数据</h1>
          <p>注销后立即停止账户访问，并在 24 小时内清理简历正文、版本和登录凭据。</p>
          <p>该操作不可撤销，也不同于可在 7 天内恢复的简历删除。</p>
        </section>
        <section className={styles.danger} aria-labelledby="delete-account-title">
          <h2 id="delete-account-title">永久注销账户</h2>
          {!csrfRequired ? (
            <p>固定开发身份不能执行账户注销。</p>
          ) : (
            <form onSubmit={(event) => void submit(event)}>
              <label>
                当前密码
                <input
                  autoComplete="current-password"
                  maxLength={200}
                  onChange={(event) => {
                    setPassword(event.target.value);
                  }}
                  required
                  type="password"
                  value={password}
                />
              </label>
              {rescue ? (
                <div className={styles.rescue}>
                  <p>发现 {rescue.count} 份未同步草稿。服务器注销不会替你保留这份本地内容。</p>
                  <button
                    onClick={() => {
                      downloadRescue(rescue.json, userId);
                      setRescueConfirmed(true);
                      setMessage('草稿副本已下载，请再次确认注销。');
                    }}
                    type="button"
                  >
                    下载草稿 JSON 副本
                  </button>
                  <button
                    onClick={() => {
                      barrierRef.current?.cancel();
                    }}
                    type="button"
                  >
                    取消注销
                  </button>
                </div>
              ) : null}
              <label className={styles.confirm}>
                <input
                  checked={confirmed}
                  onChange={(event) => {
                    setConfirmed(event.target.checked);
                  }}
                  type="checkbox"
                />
                我确认永久注销，且理解该操作不可恢复
              </label>
              {message ? (
                <p role="alert" className={styles.message}>
                  {message}
                </p>
              ) : null}
              <button disabled={pending || !confirmed || !password} type="submit">
                {pending ? '正在受理' : '永久注销账户'}
              </button>
            </form>
          )}
        </section>
      </main>
    </div>
  );
}
