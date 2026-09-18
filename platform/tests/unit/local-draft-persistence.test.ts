import 'fake-indexeddb/auto';

import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { createInitialResumeDocument, type ResumeDocumentV1 } from '@resume/domain/resume';
import {
  classifyLocalDraftError,
  DexieLocalDraftRepository,
  getOrCreateEditorTabId,
  LocalDraftController,
  LocalDraftUnavailableError,
  UnsyncedDraftsError,
  type LocalDraftRecord,
  type LocalDraftRepository,
  type LocalDraftScope,
  type LocalDraftStatus,
  type PendingSaveEnvelope,
} from '../../apps/web/src/client/editor/persistence';
import { createResumeEditorStore } from '../../apps/web/src/client/editor/store';

const databases = new Set<string>();
const fixedNow = new Date('2026-09-18T06:00:00.000Z');

function databaseName(): string {
  const name = `resume-opt-test-${randomUUID()}`;
  databases.add(name);
  return name;
}

function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => {
      resolve();
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`删除数据库失败：${name}`));
    };
    request.onblocked = () => {
      reject(new Error(`数据库仍被占用：${name}`));
    };
  });
}

afterEach(async () => {
  await Promise.all([...databases].map((name) => deleteDatabase(name)));
  databases.clear();
});

function scope(overrides: Partial<LocalDraftScope> = {}): LocalDraftScope {
  return {
    userId: randomUUID(),
    resumeId: randomUUID(),
    tabId: randomUUID(),
    ...overrides,
  };
}

function withName(document: ResumeDocumentV1, name: string): ResumeDocumentV1 {
  const next = structuredClone(document);
  const basic = Object.values(next.sectionsById).find((section) => section.kind === 'basic');
  const entry = basic?.entries[0];
  if (!entry) throw new Error('测试文档缺少基本信息');
  entry.name = name;
  return next;
}

function record(
  draftScope: LocalDraftScope,
  overrides: Partial<LocalDraftRecord> = {},
): LocalDraftRecord {
  const baseSnapshot = createInitialResumeDocument();
  return {
    formatVersion: 1,
    ...draftScope,
    baseRevision: '1',
    baseSnapshot,
    workingSnapshot: baseSnapshot,
    localSeq: 0,
    ackedSeq: 0,
    pendingEnvelope: null,
    updatedAt: fixedNow.toISOString(),
    ...overrides,
  };
}

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length() {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe('Dexie local draft repository', () => {
  it('restores a validated working copy after the database is closed and reopened', async () => {
    const name = databaseName();
    const draftScope = scope();
    const original = record(draftScope, {
      workingSnapshot: withName(createInitialResumeDocument(), '刷新后恢复'),
      localSeq: 3,
      ackedSeq: 1,
    });
    const first = new DexieLocalDraftRepository(name, () => fixedNow);
    await first.put(original);
    first.close();

    const reopened = new DexieLocalDraftRepository(name, () => fixedNow);
    await expect(reopened.get(draftScope)).resolves.toEqual(original);
    reopened.close();
  });

  it('isolates records by account, resume and tab compound key', async () => {
    const name = databaseName();
    const repository = new DexieLocalDraftRepository(name, () => fixedNow);
    const common = scope();
    const anotherTab = scope({ userId: common.userId, resumeId: common.resumeId });
    const anotherUser = scope({ resumeId: common.resumeId, tabId: common.tabId });
    await Promise.all([
      repository.put(record(common, { localSeq: 1 })),
      repository.put(record(anotherTab, { localSeq: 2 })),
      repository.put(record(anotherUser, { localSeq: 3 })),
    ]);

    expect((await repository.get(common))?.localSeq).toBe(1);
    expect((await repository.get(anotherTab))?.localSeq).toBe(2);
    expect((await repository.get(anotherUser))?.localSeq).toBe(3);
    repository.close();
  });

  it('acknowledges only the matching pending envelope and preserves newer local input', async () => {
    const name = databaseName();
    const repository = new DexieLocalDraftRepository(name, () => fixedNow);
    const draftScope = scope();
    const base = createInitialResumeDocument();
    const sent = withName(base, '已发送快照');
    const newer = withName(base, '发送后的新输入');
    const envelope: PendingSaveEnvelope = {
      idempotencyKey: randomUUID(),
      resumeId: draftScope.resumeId,
      baseRevision: '1',
      clientSeq: 1,
      document: sent,
      createdAt: fixedNow.toISOString(),
    };
    await repository.put(
      record(draftScope, {
        baseSnapshot: base,
        workingSnapshot: newer,
        localSeq: 2,
        ackedSeq: 0,
      }),
    );
    await repository.setPending(draftScope, envelope);

    await expect(
      repository.acknowledgePending(draftScope, {
        idempotencyKey: randomUUID(),
        revision: '2',
        clientSeq: 1,
        baseSnapshot: sent,
        workingSnapshot: newer,
        localSeq: 2,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.acknowledgePending(draftScope, {
        idempotencyKey: envelope.idempotencyKey,
        revision: '2',
        clientSeq: 1,
        baseSnapshot: sent,
        workingSnapshot: newer,
        localSeq: 2,
      }),
    ).resolves.toBe(true);

    await expect(repository.get(draftScope)).resolves.toMatchObject({
      baseRevision: '2',
      baseSnapshot: sent,
      workingSnapshot: newer,
      localSeq: 2,
      ackedSeq: 1,
      pendingEnvelope: null,
    });
    repository.close();
  });

  it('discards only the matching definitively rejected pending envelope', async () => {
    const name = databaseName();
    const repository = new DexieLocalDraftRepository(name, () => fixedNow);
    const draftScope = scope();
    const envelope: PendingSaveEnvelope = {
      idempotencyKey: randomUUID(),
      resumeId: draftScope.resumeId,
      baseRevision: '1',
      clientSeq: 1,
      document: createInitialResumeDocument(),
      createdAt: fixedNow.toISOString(),
    };
    await repository.put(record(draftScope, { localSeq: 1 }));
    await repository.setPending(draftScope, envelope);

    await expect(repository.discardPending(draftScope, randomUUID())).resolves.toBe(false);
    await expect(repository.get(draftScope)).resolves.toMatchObject({
      pendingEnvelope: envelope,
    });
    await expect(repository.discardPending(draftScope, envelope.idempotencyKey)).resolves.toBe(
      true,
    );
    await expect(repository.get(draftScope)).resolves.toMatchObject({ pendingEnvelope: null });
    repository.close();
  });

  it('blocks account cleanup with unsynced work, exports rescue JSON, then clears only that account', async () => {
    const name = databaseName();
    const repository = new DexieLocalDraftRepository(name, () => fixedNow);
    const firstScope = scope();
    const otherScope = scope();
    await repository.put(
      record(firstScope, {
        workingSnapshot: withName(createInitialResumeDocument(), '必须救援'),
        localSeq: 1,
      }),
    );
    await repository.put(record(otherScope));

    let blocked: UnsyncedDraftsError | null = null;
    try {
      await repository.clearAccount(firstScope.userId);
    } catch (error) {
      if (error instanceof UnsyncedDraftsError) blocked = error;
      else throw error;
    }
    expect(blocked?.unsyncedCount).toBe(1);
    expect(JSON.parse(blocked?.rescueJson ?? '{}')).toMatchObject({
      format: 'resume-opt-local-draft-rescue',
      userId: firstScope.userId,
      drafts: [{ userId: firstScope.userId, resumeId: firstScope.resumeId }],
    });
    await expect(
      repository.clearAccount(firstScope.userId, { rescueConfirmed: true }),
    ).resolves.toBe(1);
    await expect(repository.get(firstScope)).resolves.toBeNull();
    await expect(repository.get(otherScope)).resolves.not.toBeNull();
    repository.close();
  });
});

describe('local draft failure and tab boundaries', () => {
  it('classifies quota and private-mode failures without reporting success', () => {
    expect(classifyLocalDraftError(new DOMException('full', 'QuotaExceededError')).reason).toBe(
      'quota',
    );
    expect(classifyLocalDraftError(new DOMException('denied', 'SecurityError')).reason).toBe(
      'private-mode',
    );
  });

  it('keeps one tab id across refresh and replaces an invalid stored value', () => {
    const storage = new MemoryStorage();
    const first = getOrCreateEditorTabId(storage);
    expect(getOrCreateEditorTabId(storage)).toBe(first);
    storage.setItem('resume-opt.editor.tab-id', 'invalid');
    expect(getOrCreateEditorTabId(storage)).not.toBe(first);
  });
});

class FailingRepository implements LocalDraftRepository {
  constructor(private readonly failure: LocalDraftUnavailableError) {}

  get(): Promise<LocalDraftRecord | null> {
    return Promise.reject(this.failure);
  }
  put(): Promise<void> {
    return Promise.reject(this.failure);
  }
  setPending(): Promise<void> {
    return Promise.reject(this.failure);
  }
  discardPending(): Promise<boolean> {
    return Promise.reject(this.failure);
  }
  acknowledgePending(): Promise<boolean> {
    return Promise.reject(this.failure);
  }
  exportAccountRescue(): Promise<string> {
    return Promise.reject(this.failure);
  }
  clearAccount(): Promise<number> {
    return Promise.reject(this.failure);
  }
  delete(): Promise<void> {
    return Promise.reject(this.failure);
  }
  close(): void {}
}

describe('LocalDraftController', () => {
  it('backs up store edits and restores them into a fresh store after refresh', async () => {
    const name = databaseName();
    const draftScope = scope();
    const remote = createInitialResumeDocument();
    const firstRepository = new DexieLocalDraftRepository(name, () => fixedNow);
    const firstStore = createResumeEditorStore({ document: remote, revision: '1' });
    const statuses: LocalDraftStatus[] = [];
    const first = new LocalDraftController({
      repository: firstRepository,
      scope: draftScope,
      store: firstStore,
      remoteDocument: remote,
      remoteRevision: '1',
      debounceMs: 0,
      now: () => fixedNow,
      onStatus: (status) => statuses.push(status),
    });
    await first.start();
    const targetSection = remote.moduleOrder.find(
      (id) => remote.sectionsById[id]?.kind !== 'basic',
    );
    if (!targetSection) throw new Error('测试文档缺少可隐藏模块');
    firstStore.getState().dispatch({
      type: 'set-section-visibility',
      sectionId: targetSection,
      visible: false,
    });
    await first.flush();
    expect(statuses.at(-1)?.phase).toBe('backed-up');
    await first.dispose();

    const reopened = new DexieLocalDraftRepository(name, () => fixedNow);
    const restoredRecord = await reopened.get(draftScope);
    const restoredStore = createResumeEditorStore({ document: remote, revision: '1' });
    const restoredStatuses: LocalDraftStatus[] = [];
    const second = new LocalDraftController({
      repository: reopened,
      scope: draftScope,
      store: restoredStore,
      remoteDocument: remote,
      remoteRevision: '1',
      initialRecord: restoredRecord,
      now: () => fixedNow,
      onStatus: (status) => restoredStatuses.push(status),
    });
    await second.start();

    expect(restoredStore.getState()).toMatchObject({ localSeq: 1, ackedSeq: 0, isDirty: true });
    expect(restoredStore.getState().document.sectionsById[targetSection]?.visible).toBe(false);
    expect(restoredStatuses.at(-1)?.phase).toBe('recovered');
    await second.dispose();
  });

  it('reports quota failure and still produces a current rescue export', async () => {
    const draftScope = scope();
    const remote = createInitialResumeDocument();
    const store = createResumeEditorStore({ document: remote, revision: '1' });
    const statuses: LocalDraftStatus[] = [];
    const controller = new LocalDraftController({
      repository: new FailingRepository(new LocalDraftUnavailableError('quota')),
      scope: draftScope,
      store,
      remoteDocument: remote,
      remoteRevision: '1',
      onStatus: (status) => statuses.push(status),
    });
    await controller.start();

    expect(statuses.at(-1)).toEqual({ phase: 'error', failureReason: 'quota' });
    expect(JSON.parse(controller.createCurrentRescueJson())).toMatchObject({
      format: 'resume-opt-local-draft-rescue',
      userId: draftScope.userId,
      drafts: [{ resumeId: draftScope.resumeId }],
    });
    await controller.dispose();
  });

  it('persists an explicit conflict rebase and can later replace the working copy from remote', async () => {
    const name = databaseName();
    const draftScope = scope();
    const base = createInitialResumeDocument();
    const sectionId = base.moduleOrder[1];
    if (!sectionId) throw new Error('fixture 缺少冲突模块');
    const repository = new DexieLocalDraftRepository(name, () => fixedNow);
    const store = createResumeEditorStore({ document: base, revision: '1' });
    const controller = new LocalDraftController({
      repository,
      scope: draftScope,
      store,
      remoteDocument: base,
      remoteRevision: '1',
      debounceMs: 0,
      now: () => fixedNow,
      onStatus: () => undefined,
    });
    await controller.start();
    store.getState().dispatch({ type: 'set-section-title', sectionId, title: '本地分支' });
    await controller.flush();
    const firstEnvelope: PendingSaveEnvelope = {
      idempotencyKey: randomUUID(),
      resumeId: draftScope.resumeId,
      baseRevision: '1',
      clientSeq: 1,
      document: store.getState().document,
      createdAt: fixedNow.toISOString(),
    };
    await controller.freezePending(firstEnvelope);
    const remoteAtTwo = structuredClone(base);
    const remoteAtTwoSection = remoteAtTwo.sectionsById[sectionId];
    if (!remoteAtTwoSection) throw new Error('fixture 缺少服务器模块');
    remoteAtTwoSection.title = '服务器分支';

    await controller.rebaseLocalOntoRemote({
      resumeId: draftScope.resumeId,
      document: remoteAtTwo,
      revision: '2',
    });
    expect(store.getState()).toMatchObject({ ackRevision: '2', isDirty: true });
    await expect(repository.get(draftScope)).resolves.toMatchObject({
      baseRevision: '2',
      baseSnapshot: remoteAtTwo,
      workingSnapshot: store.getState().document,
      pendingEnvelope: null,
    });

    const secondEnvelope: PendingSaveEnvelope = {
      ...firstEnvelope,
      idempotencyKey: randomUUID(),
      baseRevision: '2',
      document: store.getState().document,
    };
    await controller.freezePending(secondEnvelope);
    const remoteAtThree = structuredClone(remoteAtTwo);
    const remoteAtThreeSection = remoteAtThree.sectionsById[sectionId];
    if (!remoteAtThreeSection) throw new Error('fixture 缺少最终服务器模块');
    remoteAtThreeSection.title = '最终服务器版本';
    await controller.adoptRemote({
      resumeId: draftScope.resumeId,
      document: remoteAtThree,
      revision: '3',
    });
    expect(store.getState()).toMatchObject({ ackRevision: '3', isDirty: false });
    expect(store.getState().document.sectionsById[sectionId]?.title).toBe('最终服务器版本');
    await expect(repository.get(draftScope)).resolves.toMatchObject({
      baseRevision: '3',
      baseSnapshot: remoteAtThree,
      workingSnapshot: remoteAtThree,
      localSeq: 0,
      ackedSeq: 0,
      pendingEnvelope: null,
    });
    await controller.dispose();
  });
});
