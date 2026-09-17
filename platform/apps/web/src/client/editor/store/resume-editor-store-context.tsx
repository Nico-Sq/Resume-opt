'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useStore } from 'zustand';

import type { ResumeEditorState, ResumeEditorStore } from './resume-editor-store';

const ResumeEditorStoreContext = createContext<ResumeEditorStore | null>(null);

export function useResumeEditorStoreApi(): ResumeEditorStore {
  const store = useContext(ResumeEditorStoreContext);
  if (!store) throw new Error('编辑器 Store 必须在 ResumeEditorStoreProvider 内使用');
  return store;
}

export function ResumeEditorStoreProvider({
  store,
  children,
}: {
  store: ResumeEditorStore;
  children: ReactNode;
}) {
  return (
    <ResumeEditorStoreContext.Provider value={store}>{children}</ResumeEditorStoreContext.Provider>
  );
}

export function useResumeEditorStore<T>(selector: (state: ResumeEditorState) => T): T {
  return useStore(useResumeEditorStoreApi(), selector);
}
