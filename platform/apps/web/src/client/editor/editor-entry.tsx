'use client';

import { ResumeDocumentV1Schema } from '@resume/domain/resume';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import {
  classifyLocalDraftError,
  DexieLocalDraftRepository,
  getOrCreateEditorTabId,
  type LocalDraftRecord,
  type LocalDraftScope,
  type LocalDraftUnavailableError,
} from './persistence';
import {
  EditorWorkspace,
  type EditorLocalDraftContext,
  type EditorResume,
} from './editor-workspace';
import styles from './editor-workspace.module.css';
import { HttpSaveTransport } from './saving';

const EditorResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    title: z.string(),
    document: ResumeDocumentV1Schema,
    revision: z.string().regex(/^[1-9]\d*$/u),
  }),
});
const SessionResponseSchema = z.object({
  data: z
    .object({
      userId: z.uuid(),
      emailVerified: z.boolean(),
    })
    .nullable(),
});
const CsrfResponseSchema = z.object({
  data: z.object({ csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/u) }),
});

type LoadState =
  | { status: 'loading' }
  | {
      status: 'ready';
      resume: EditorResume;
      localDraft: EditorLocalDraftContext;
      saveTransport: HttpSaveTransport;
      accountUserId: string;
    }
  | { status: 'error'; message: string };

async function loadEditorResume(
  resumeId: string,
  fixedUserId: string | undefined,
  csrfRequired: boolean,
  signal: AbortSignal,
): Promise<{
  resume: EditorResume;
  localDraft: EditorLocalDraftContext;
  saveTransport: HttpSaveTransport;
  accountUserId: string;
}> {
  let userId = fixedUserId;
  if (!userId) {
    const sessionResponse = await fetch('/api/v1/session', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!sessionResponse.ok) throw new Error('登录状态暂时无法确认');
    const session = SessionResponseSchema.parse(await sessionResponse.json()).data;
    if (!session?.emailVerified) throw new Error('请先登录并完成邮箱验证');
    userId = session.userId;
  }

  const response = await fetch(`/api/v1/resumes/${encodeURIComponent(resumeId)}`, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) {
    if (response.status === 401) throw new Error('登录已失效，请重新登录');
    if (response.status === 404) throw new Error('简历不存在或无权访问');
    const error = (await response.json().catch(() => null)) as { code?: unknown } | null;
    if (error?.code === 'STORED_RESUME_INVALID') throw new Error('已保存的简历内容损坏');
    throw new Error('简历暂时无法加载');
  }
  const payload: unknown = await response.json();
  const resume = EditorResponseSchema.parse(payload).data;
  let csrfToken: string | undefined;
  if (csrfRequired) {
    const csrfResponse = await fetch('/api/v1/csrf', {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal,
    });
    if (!csrfResponse.ok) throw new Error('保存凭据暂时无法获取');
    csrfToken = CsrfResponseSchema.parse(await csrfResponse.json()).data.csrfToken;
  }
  const repository = new DexieLocalDraftRepository();
  let tabId = crypto.randomUUID();
  let initialRecord: LocalDraftRecord | null = null;
  let initialError: LocalDraftUnavailableError | undefined;
  try {
    tabId = getOrCreateEditorTabId(window.sessionStorage);
    const scope: LocalDraftScope = { userId, resumeId: resume.id, tabId };
    initialRecord = await repository.get(scope);
  } catch (error) {
    initialError = classifyLocalDraftError(error);
  }
  if (signal.aborted) {
    repository.close();
    throw new DOMException('编辑器加载已取消', 'AbortError');
  }
  const scope: LocalDraftScope = { userId, resumeId: resume.id, tabId };
  return {
    resume,
    localDraft: {
      repository,
      scope,
      initialRecord,
      ...(initialError ? { initialError } : {}),
    },
    saveTransport: new HttpSaveTransport(undefined, csrfToken),
    accountUserId: userId,
  };
}

export function EditorEntry({
  resumeId,
  fixedUserId,
  csrfRequired,
}: {
  resumeId: string;
  fixedUserId?: string | undefined;
  csrfRequired: boolean;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void loadEditorResume(resumeId, fixedUserId, csrfRequired, controller.signal).then(
      ({ resume, localDraft, saveTransport, accountUserId }) => {
        setState({
          status: 'ready',
          resume,
          localDraft,
          saveTransport,
          accountUserId,
        });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : '简历暂时无法加载',
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [attempt, csrfRequired, fixedUserId, resumeId]);

  if (state.status === 'ready') {
    return (
      <EditorWorkspace
        accountUserId={state.accountUserId}
        canSignOut={csrfRequired}
        initialResume={state.resume}
        localDraft={state.localDraft}
        saveTransport={state.saveTransport}
      />
    );
  }
  return (
    <main className={styles.entryState}>
      <section aria-live="polite" className={styles.entryStatePanel}>
        <p className={styles.eyebrow}>简历编辑器</p>
        <h1>{state.status === 'loading' ? '正在打开简历' : '无法打开简历'}</h1>
        <p>{state.status === 'loading' ? '正在读取结构化内容与版本信息。' : state.message}</p>
        {state.status === 'error' ? (
          <button
            onClick={() => {
              setState({ status: 'loading' });
              setAttempt((value) => value + 1);
            }}
            type="button"
          >
            重新加载
          </button>
        ) : null}
      </section>
    </main>
  );
}
