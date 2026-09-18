import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInitialResumeDocument, type ResumeDocumentV1 } from '@resume/domain/resume';
import type {
  PendingSaveEnvelope,
  RemoteResumeSnapshot,
} from '../../apps/web/src/client/editor/persistence';
import {
  SaveCoordinator,
  SaveTransportError,
  type SaveCoordinatorStatus,
  type SavePersistence,
  type SaveReceipt,
  type SaveTransport,
} from '../../apps/web/src/client/editor/saving';
import {
  createResumeEditorStore,
  type ResumeEditorStore,
} from '../../apps/web/src/client/editor/store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function editableSectionId(document: ResumeDocumentV1): string {
  const sectionId = document.moduleOrder.find((id) => document.sectionsById[id]?.kind !== 'basic');
  if (!sectionId) throw new Error('fixture 缺少可编辑模块');
  return sectionId;
}

function receipt(envelope: PendingSaveEnvelope, revision: string): SaveReceipt {
  return {
    resumeId: envelope.resumeId,
    revision,
    versionId: randomUUID(),
    acknowledgedSeq: envelope.clientSeq,
    savedAt: '2026-09-18T08:00:00.000Z',
    contentHash: 'a'.repeat(64),
  };
}

class MemorySavePersistence implements SavePersistence {
  pending: PendingSaveEnvelope | null = null;
  readonly frozen: PendingSaveEnvelope[] = [];
  readonly acknowledged: Array<Parameters<SavePersistence['acknowledgePending']>[0]> = [];
  flushCount = 0;
  private baseDocument: ResumeDocumentV1;
  private baseRevision: string;

  constructor(private readonly store: ResumeEditorStore) {
    this.baseDocument = store.getState().document;
    this.baseRevision = store.getState().ackRevision;
  }

  flush(): Promise<void> {
    this.flushCount += 1;
    return Promise.resolve();
  }

  getPendingEnvelope(): PendingSaveEnvelope | null {
    return this.pending;
  }

  getConflictContext() {
    if (!this.pending) return null;
    return {
      baseRevision: this.baseRevision,
      baseSnapshot: this.baseDocument,
      pendingEnvelope: this.pending,
    };
  }

  freezePending(envelope: PendingSaveEnvelope): Promise<void> {
    if (this.pending && this.pending.idempotencyKey !== envelope.idempotencyKey) {
      return Promise.reject(new Error('只能存在一个 pending envelope'));
    }
    this.pending = envelope;
    this.frozen.push(envelope);
    return Promise.resolve();
  }

  acknowledgePending(
    input: Parameters<SavePersistence['acknowledgePending']>[0],
  ): Promise<boolean> {
    if (
      !this.pending ||
      this.pending.idempotencyKey !== input.idempotencyKey ||
      this.pending.clientSeq !== input.clientSeq
    ) {
      return Promise.resolve(false);
    }
    this.acknowledged.push(input);
    this.pending = null;
    this.baseDocument = input.baseSnapshot;
    this.baseRevision = input.revision;
    return Promise.resolve(
      this.store.getState().acknowledge({
        clientSeq: input.clientSeq,
        revision: input.revision,
      }),
    );
  }

  discardPending(idempotencyKey: string): Promise<boolean> {
    if (this.pending?.idempotencyKey !== idempotencyKey) return Promise.resolve(false);
    this.pending = null;
    return Promise.resolve(true);
  }

  adoptRemote(snapshot: RemoteResumeSnapshot): Promise<void> {
    this.pending = null;
    this.baseDocument = snapshot.document;
    this.baseRevision = snapshot.revision;
    this.store.getState().replaceFromRemote({
      document: snapshot.document,
      revision: snapshot.revision,
    });
    return Promise.resolve();
  }

  rebaseLocalOntoRemote(snapshot: RemoteResumeSnapshot): Promise<void> {
    this.pending = null;
    this.baseDocument = snapshot.document;
    this.baseRevision = snapshot.revision;
    const state = this.store.getState();
    this.store.getState().hydrateWorkingCopy({
      document: state.document,
      localSeq: state.localSeq,
      ackedSeq: state.ackedSeq,
      ackRevision: snapshot.revision,
    });
    return Promise.resolve();
  }
}

class ControlledTransport implements SaveTransport {
  readonly calls: Array<{
    envelope: PendingSaveEnvelope;
    result: ReturnType<typeof deferred<SaveReceipt>>;
  }> = [];

  save(envelope: PendingSaveEnvelope): Promise<SaveReceipt> {
    const result = deferred<SaveReceipt>();
    this.calls.push({ envelope, result });
    return result.promise;
  }
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('SaveCoordinator', () => {
  it('allows one in-flight request and never lets an older ACK overwrite newer input', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const statuses: SaveCoordinatorStatus[] = [];
    const coordinator = new SaveCoordinator({
      resumeId: randomUUID(),
      store,
      persistence,
      transport,
      debounceMs: 0,
      onStatus: (status) => statuses.push(status),
    });
    coordinator.start();

    store.getState().dispatch({
      type: 'set-section-visibility',
      sectionId,
      visible: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(1);
    const firstCall = transport.calls[0];
    if (!firstCall) throw new Error('缺少第一次保存请求');

    store.getState().dispatch({
      type: 'set-section-title',
      sectionId,
      title: '发送后的新输入',
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(transport.calls).toHaveLength(1);

    firstCall.result.resolve(receipt(firstCall.envelope, '2'));
    await settle();
    expect(store.getState()).toMatchObject({
      localSeq: 2,
      ackedSeq: 1,
      ackRevision: '2',
      isDirty: true,
    });
    expect(store.getState().document.sectionsById[sectionId]?.title).toBe('发送后的新输入');
    expect(transport.calls).toHaveLength(2);
    const secondCall = transport.calls[1];
    if (!secondCall) throw new Error('缺少第二次保存请求');
    expect(secondCall.envelope).toMatchObject({ baseRevision: '2', clientSeq: 2 });
    expect(secondCall.envelope.idempotencyKey).not.toBe(firstCall.envelope.idempotencyKey);

    secondCall.result.resolve(receipt(secondCall.envelope, '3'));
    await settle();
    expect(store.getState()).toMatchObject({ ackedSeq: 2, ackRevision: '3', isDirty: false });
    expect(statuses.at(-1)).toMatchObject({ phase: 'synced', revision: '3' });
    coordinator.dispose();
  });

  it('replays a lost-response envelope with the original key and frozen body', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const coordinator = new SaveCoordinator({
      resumeId: randomUUID(),
      store,
      persistence,
      transport,
      debounceMs: 0,
      maxAutomaticRetries: 0,
      onStatus: () => undefined,
    });
    coordinator.start();
    store.getState().dispatch({
      type: 'set-section-visibility',
      sectionId,
      visible: false,
    });
    await vi.advanceTimersByTimeAsync(0);
    const firstCall = transport.calls[0];
    if (!firstCall) throw new Error('缺少第一次保存请求');
    firstCall.result.reject(new SaveTransportError('network', '响应丢失'));
    await settle();

    const retry = coordinator.retryNow();
    await settle();
    const retryCall = transport.calls[1];
    if (!retryCall) throw new Error('缺少重试请求');
    expect(retryCall.envelope).toEqual(firstCall.envelope);
    retryCall.result.resolve(receipt(retryCall.envelope, '2'));
    await retry;
    expect(store.getState().isDirty).toBe(false);
    coordinator.dispose();
  });

  it('waits before an automatic retry and does not let flush create a parallel request', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const statuses: SaveCoordinatorStatus[] = [];
    const coordinator = new SaveCoordinator({
      resumeId: randomUUID(),
      store,
      persistence,
      transport,
      debounceMs: 0,
      maxAutomaticRetries: 2,
      retryBaseMs: 1_000,
      random: () => 0.5,
      onStatus: (status) => statuses.push(status),
    });
    coordinator.start();
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '等待重试' });
    await vi.advanceTimersByTimeAsync(0);
    const firstCall = transport.calls[0];
    if (!firstCall) throw new Error('缺少第一次保存请求');
    firstCall.result.reject(new SaveTransportError('network', '临时断网'));
    await settle();
    expect(statuses.at(-1)).toMatchObject({ phase: 'retry-wait', attempt: 1, retryInMs: 1_000 });

    await coordinator.flush();
    await vi.advanceTimersByTimeAsync(999);
    expect(transport.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.calls).toHaveLength(2);
    const retryCall = transport.calls[1];
    if (!retryCall) throw new Error('缺少自动重试请求');
    expect(retryCall.envelope).toEqual(firstCall.envelope);
    retryCall.result.resolve(receipt(retryCall.envelope, '2'));
    await settle();
    expect(store.getState().isDirty).toBe(false);
    coordinator.dispose();
  });

  it('debounces rapid edits and freezes only the latest snapshot', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const coordinator = new SaveCoordinator({
      resumeId: randomUUID(),
      store,
      persistence,
      transport,
      debounceMs: 800,
      onStatus: () => undefined,
    });
    coordinator.start();

    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '第一次输入' });
    await vi.advanceTimersByTimeAsync(500);
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '最终输入' });
    await vi.advanceTimersByTimeAsync(799);
    expect(transport.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0]?.envelope).toMatchObject({ clientSeq: 2 });
    expect(transport.calls[0]?.envelope.document.sectionsById[sectionId]?.title).toBe('最终输入');
    coordinator.dispose();
  });

  it('resumes a persisted pending envelope immediately after refresh', async () => {
    const document = createInitialResumeDocument();
    const store = createResumeEditorStore({ document, revision: '1' });
    store.getState().hydrateWorkingCopy({
      document,
      localSeq: 1,
      ackedSeq: 0,
      ackRevision: '1',
    });
    const persistence = new MemorySavePersistence(store);
    persistence.pending = {
      idempotencyKey: randomUUID(),
      resumeId: randomUUID(),
      baseRevision: '1',
      clientSeq: 1,
      document,
      createdAt: '2026-09-18T08:00:00.000Z',
    };
    const transport = new ControlledTransport();
    const coordinator = new SaveCoordinator({
      resumeId: persistence.pending.resumeId,
      store,
      persistence,
      transport,
      onStatus: () => undefined,
    });

    coordinator.start();
    await settle();
    expect(transport.calls[0]?.envelope).toEqual(persistence.pending);
    coordinator.dispose();
  });

  it('drops a definitively rejected validation envelope after a new edit', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const coordinator = new SaveCoordinator({
      resumeId: randomUUID(),
      store,
      persistence,
      transport,
      debounceMs: 0,
      onStatus: () => undefined,
    });
    coordinator.start();
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '无效内容' });
    await vi.advanceTimersByTimeAsync(0);
    const rejected = transport.calls[0];
    if (!rejected) throw new Error('缺少被拒绝请求');
    rejected.result.reject(new SaveTransportError('validation', '内容校验失败'));
    await settle();
    expect(persistence.pending).toBeNull();

    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '修正后内容' });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.calls).toHaveLength(2);
    expect(transport.calls[1]?.envelope.idempotencyKey).not.toBe(rejected.envelope.idempotencyKey);
    coordinator.dispose();
  });

  it('adopts a remote conflict snapshot only after explicit resolution', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const statuses: SaveCoordinatorStatus[] = [];
    const resumeId = randomUUID();
    const coordinator = new SaveCoordinator({
      resumeId,
      store,
      persistence,
      transport,
      debounceMs: 0,
      onStatus: (status) => statuses.push(status),
    });
    coordinator.start();
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '本地修改' });
    await vi.advanceTimersByTimeAsync(0);
    const conflicted = transport.calls[0];
    if (!conflicted) throw new Error('缺少冲突请求');
    conflicted.result.reject(
      new SaveTransportError('conflict', '版本冲突', { currentRevision: '2' }),
    );
    await settle();

    expect(statuses.at(-1)).toMatchObject({ phase: 'conflict', currentRevision: '2' });
    expect(coordinator.getConflictContext()).toMatchObject({
      baseRevision: '1',
      pendingEnvelope: conflicted.envelope,
    });
    expect(store.getState().document.sectionsById[sectionId]?.title).toBe('本地修改');

    const remoteDocument = structuredClone(document);
    const remoteSection = remoteDocument.sectionsById[sectionId];
    if (!remoteSection) throw new Error('fixture 缺少服务器模块');
    remoteSection.title = '服务器修改';
    await expect(
      coordinator.adoptRemote({ resumeId, document: remoteDocument, revision: '2' }),
    ).resolves.toBe(true);
    expect(store.getState()).toMatchObject({ ackRevision: '2', isDirty: false });
    expect(store.getState().document.sectionsById[sectionId]?.title).toBe('服务器修改');
    expect(statuses.at(-1)).toMatchObject({ phase: 'synced', revision: '2' });
    coordinator.dispose();
  });

  it('rebases the full local snapshot and pauses safely when a second conflict occurs', async () => {
    const document = createInitialResumeDocument();
    const sectionId = editableSectionId(document);
    const store = createResumeEditorStore({ document, revision: '1' });
    const persistence = new MemorySavePersistence(store);
    const transport = new ControlledTransport();
    const statuses: SaveCoordinatorStatus[] = [];
    const resumeId = randomUUID();
    const coordinator = new SaveCoordinator({
      resumeId,
      store,
      persistence,
      transport,
      debounceMs: 0,
      onStatus: (status) => statuses.push(status),
    });
    coordinator.start();
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '保留本地全文' });
    await vi.advanceTimersByTimeAsync(0);
    const first = transport.calls[0];
    if (!first) throw new Error('缺少第一次冲突请求');
    first.result.reject(new SaveTransportError('conflict', '版本冲突', { currentRevision: '2' }));
    await settle();

    const remoteDocument = createInitialResumeDocument();
    const resolution = coordinator.rebaseLocalOntoRemote({
      resumeId,
      document: remoteDocument,
      revision: '2',
    });
    await settle();
    const second = transport.calls[1];
    if (!second) throw new Error('缺少重定基线后的保存请求');
    expect(second.envelope.baseRevision).toBe('2');
    expect(second.envelope.idempotencyKey).not.toBe(first.envelope.idempotencyKey);
    expect(second.envelope.document.sectionsById[sectionId]?.title).toBe('保留本地全文');
    second.result.reject(new SaveTransportError('conflict', '再次冲突', { currentRevision: '3' }));
    await resolution;
    expect(statuses.at(-1)).toMatchObject({ phase: 'conflict', currentRevision: '3' });
    expect(store.getState().document.sectionsById[sectionId]?.title).toBe('保留本地全文');
    expect(store.getState().isDirty).toBe(true);
    coordinator.dispose();
  });
});
