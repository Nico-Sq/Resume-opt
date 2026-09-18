'use client';

import { useEffect, useMemo, type ChangeEvent, type CompositionEvent } from 'react';
import { useController, type Control, type FieldPath, type FieldValues } from 'react-hook-form';
import { useStore } from 'zustand';

import { createEntryFieldEditSession, type EntryFieldTarget } from './field-edit-session';
import type { ResumeEditorState, ResumeEditorStore } from './resume-editor-store';

function readPrimitiveField(state: ResumeEditorState, target: EntryFieldTarget): unknown {
  const sectionValue = state.document.sectionsById[target.sectionId];
  const entry = sectionValue?.entries.find((candidate) => candidate.id === target.entryId);
  let cursor: unknown = entry;
  for (const part of target.path) {
    if (Array.isArray(cursor) && typeof part === 'number') {
      cursor = cursor[part];
      continue;
    }
    if (cursor === null || typeof cursor !== 'object' || typeof part !== 'string') {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function useResumeTextField<
  TFieldValues extends FieldValues,
  TName extends FieldPath<TFieldValues>,
>({
  control,
  name,
  store,
  target,
}: {
  control: Control<TFieldValues>;
  name: TName;
  store: ResumeEditorStore;
  target: EntryFieldTarget;
}) {
  const controller = useController({ control, name });
  const pathKey = JSON.stringify(target.path);
  const stableTarget = useMemo<EntryFieldTarget>(
    () => ({
      sectionId: target.sectionId,
      entryId: target.entryId,
      path: JSON.parse(pathKey) as Array<string | number>,
    }),
    [pathKey, target.entryId, target.sectionId],
  );
  const session = useMemo(
    () => createEntryFieldEditSession(store, stableTarget),
    [stableTarget, store],
  );
  const storeValue = useStore(store, (state) => readPrimitiveField(state, stableTarget));
  const formValue: unknown = controller.field.value;

  useEffect(() => {
    const normalizedStoreValue =
      typeof storeValue === 'string' ? storeValue : storeValue === null ? '' : undefined;
    if (normalizedStoreValue !== undefined && normalizedStoreValue !== formValue) {
      controller.field.onChange(normalizedStoreValue);
    }
  }, [controller.field, formValue, storeValue]);

  useEffect(() => {
    return () => {
      session.cancel();
    };
  }, [session]);

  return {
    ...controller,
    field: {
      ...controller.field,
      onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        controller.field.onChange(event);
        const value = event.currentTarget.value;
        if ((event.nativeEvent as InputEvent).isComposing) session.compositionUpdate(value);
        else session.change(value);
      },
      onBlur: () => {
        session.blur();
        controller.field.onBlur();
      },
      onCompositionStart: () => {
        session.compositionStart();
      },
      onCompositionEnd: (event: CompositionEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        const value = event.currentTarget.value;
        controller.field.onChange(value);
        session.compositionEnd(value);
      },
    },
  };
}
