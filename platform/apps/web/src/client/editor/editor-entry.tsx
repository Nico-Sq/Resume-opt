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

const EditorResponseSchema = z.object({
  data: z.object({
    id: z.uuid(),
    title: z.string(),
    document: ResumeDocumentV1Schema,
    revision: z.string().regex(/^[1-9]\d*$/u),
  }),
});

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; resume: EditorResume; localDraft: EditorLocalDraftContext }
  | { status: 'error'; message: string };

async function loadEditorResume(
  signal: AbortSignal,
): Promise<{ resume: EditorResume; localDraft: EditorLocalDraftContext }> {
  const response = await fetch('/api/v1/editor-bootstrap', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error('固定测试简历暂时无法加载');
  const payload: unknown = await response.json();
  const resume = EditorResponseSchema.parse(payload).data;
  const userId = z.uuid().parse(response.headers.get('x-local-draft-account'));
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
  };
}

export function EditorEntry() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void loadEditorResume(controller.signal).then(
      ({ resume, localDraft }) => {
        setState({ status: 'ready', resume, localDraft });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: 'error',
          message: error instanceof Error ? error.message : '固定测试简历暂时无法加载',
        });
      },
    );
    return () => {
      controller.abort();
    };
  }, [attempt]);

  if (state.status === 'ready') {
    return <EditorWorkspace initialResume={state.resume} localDraft={state.localDraft} />;
  }
  return (
    <main className={styles.entryState}>
      <section aria-live="polite" className={styles.entryStatePanel}>
        <p className={styles.eyebrow}>V0.1 固定测试入口</p>
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
