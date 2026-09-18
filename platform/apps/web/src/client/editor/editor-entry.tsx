'use client';

import { ResumeDocumentV1Schema } from '@resume/domain/resume';
import { useEffect, useState } from 'react';
import { z } from 'zod';

import { EditorWorkspace, type EditorResume } from './editor-workspace';
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
  | { status: 'ready'; resume: EditorResume }
  | { status: 'error'; message: string };

async function loadEditorResume(signal: AbortSignal): Promise<EditorResume> {
  const response = await fetch('/api/v1/editor-bootstrap', {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
    signal,
  });
  if (!response.ok) throw new Error('固定测试简历暂时无法加载');
  const payload: unknown = await response.json();
  return EditorResponseSchema.parse(payload).data;
}

export function EditorEntry() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void loadEditorResume(controller.signal).then(
      (resume) => {
        setState({ status: 'ready', resume });
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

  if (state.status === 'ready') return <EditorWorkspace initialResume={state.resume} />;
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
