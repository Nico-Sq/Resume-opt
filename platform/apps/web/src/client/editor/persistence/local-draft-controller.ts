import type { ResumeDocumentV1 } from '@resume/domain/resume';

import type { ResumeEditorStore } from '../store';
import {
  LocalDraftUnavailableError,
  type AcknowledgePendingInput,
  type LocalDraftFailureReason,
  type LocalDraftRepository,
} from './local-draft-repository';
import {
  hasUnsyncedLocalChanges,
  parseLocalDraftRecord,
  type LocalDraftRecord,
  type LocalDraftRescueExport,
  type LocalDraftScope,
  type PendingSaveEnvelope,
} from './local-draft-schema';

export type LocalDraftPhase = 'initializing' | 'backing-up' | 'backed-up' | 'recovered' | 'error';

export interface LocalDraftStatus {
  phase: LocalDraftPhase;
  failureReason?: LocalDraftFailureReason;
  updatedAt?: string;
}

export interface RemoteResumeSnapshot {
  resumeId: string;
  document: ResumeDocumentV1;
  revision: string;
}

export interface LocalDraftConflictContext {
  baseRevision: string;
  baseSnapshot: ResumeDocumentV1;
  pendingEnvelope: PendingSaveEnvelope;
}

export interface LocalDraftControllerOptions {
  repository: LocalDraftRepository;
  scope: LocalDraftScope;
  store: ResumeEditorStore;
  remoteDocument: ResumeDocumentV1;
  remoteRevision: string;
  initialRecord?: LocalDraftRecord | null;
  initialError?: LocalDraftUnavailableError;
  debounceMs?: number;
  now?: () => Date;
  onStatus: (status: LocalDraftStatus) => void;
}

function samePersistedState(
  left: {
    document: ResumeDocumentV1;
    localSeq: number;
    ackedSeq: number;
    ackRevision: string;
  },
  right: {
    document: ResumeDocumentV1;
    localSeq: number;
    ackedSeq: number;
    ackRevision: string;
  },
) {
  return (
    left.document === right.document &&
    left.localSeq === right.localSeq &&
    left.ackedSeq === right.ackedSeq &&
    left.ackRevision === right.ackRevision
  );
}

export class LocalDraftController {
  readonly #debounceMs: number;
  readonly #now: () => Date;
  #baseRevision: string;
  #baseSnapshot: ResumeDocumentV1;
  #pendingEnvelope: LocalDraftRecord['pendingEnvelope'] = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #disposed = false;
  #started = false;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: LocalDraftControllerOptions) {
    this.#debounceMs = options.debounceMs ?? 200;
    if (!Number.isSafeInteger(this.#debounceMs) || this.#debounceMs < 0) {
      throw new Error('本地草稿防抖时间必须是非负安全整数');
    }
    this.#now = options.now ?? (() => new Date());
    this.#baseRevision = options.remoteRevision;
    this.#baseSnapshot = options.remoteDocument;
  }

  async start(): Promise<void> {
    if (this.#started) throw new Error('本地草稿控制器不能重复启动');
    this.#started = true;
    this.options.onStatus({ phase: 'initializing' });
    if (this.options.initialError) {
      this.#reportError(this.options.initialError);
      return;
    }

    try {
      const existing =
        this.options.initialRecord === undefined
          ? await this.options.repository.get(this.options.scope)
          : this.options.initialRecord;
      if (existing && hasUnsyncedLocalChanges(existing)) {
        this.#baseRevision = existing.baseRevision;
        this.#baseSnapshot = existing.baseSnapshot;
        this.#pendingEnvelope = existing.pendingEnvelope;
        this.options.store.getState().hydrateWorkingCopy({
          document: existing.workingSnapshot,
          localSeq: existing.localSeq,
          ackedSeq: existing.ackedSeq,
          ackRevision: existing.baseRevision,
        });
        this.options.onStatus({ phase: 'recovered', updatedAt: existing.updatedAt });
      } else {
        this.#baseRevision = this.options.remoteRevision;
        this.#baseSnapshot = this.options.remoteDocument;
        this.#pendingEnvelope = null;
        await this.#persistCurrent();
      }
      this.#subscribe();
    } catch (error) {
      this.#reportError(error);
    }
  }

  #subscribe(): void {
    this.#unsubscribe = this.options.store.subscribe(
      (state) => ({
        document: state.document,
        localSeq: state.localSeq,
        ackedSeq: state.ackedSeq,
        ackRevision: state.ackRevision,
      }),
      () => {
        this.#schedule();
      },
      { equalityFn: samePersistedState },
    );
  }

  #schedule(): void {
    if (this.#disposed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.options.onStatus({ phase: 'backing-up' });
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.flush();
    }, this.#debounceMs);
  }

  #currentRecord(): LocalDraftRecord {
    const state = this.options.store.getState();
    return parseLocalDraftRecord({
      formatVersion: 1,
      ...this.options.scope,
      baseRevision: this.#baseRevision,
      baseSnapshot: this.#baseSnapshot,
      workingSnapshot: state.document,
      localSeq: state.localSeq,
      ackedSeq: state.ackedSeq,
      pendingEnvelope: this.#pendingEnvelope,
      updatedAt: this.#now().toISOString(),
    });
  }

  async #persistCurrent(): Promise<void> {
    await this.#enqueueWrite(async () => {
      const record = this.#currentRecord();
      await this.options.repository.put(record);
      if (!this.#disposed) {
        this.options.onStatus({ phase: 'backed-up', updatedAt: record.updatedAt });
      }
    });
  }

  #enqueueWrite(work: () => Promise<void>): Promise<void> {
    const result = this.#writeQueue.then(work, work);
    this.#writeQueue = result.catch(() => undefined);
    return result;
  }

  async flush(): Promise<void> {
    if (this.#disposed || this.options.initialError) return;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      await this.#persistCurrent();
    } catch (error) {
      this.#reportError(error);
    }
  }

  createCurrentRescueJson(): string {
    const payload: LocalDraftRescueExport = {
      format: 'resume-opt-local-draft-rescue',
      formatVersion: 1,
      userId: this.options.scope.userId,
      exportedAt: this.#now().toISOString(),
      drafts: [this.#currentRecord()],
    };
    return JSON.stringify(payload, null, 2);
  }

  getPendingEnvelope(): PendingSaveEnvelope | null {
    return this.#pendingEnvelope;
  }

  getConflictContext(): LocalDraftConflictContext | null {
    if (!this.#pendingEnvelope) return null;
    return {
      baseRevision: this.#baseRevision,
      baseSnapshot: this.#baseSnapshot,
      pendingEnvelope: this.#pendingEnvelope,
    };
  }

  async freezePending(envelope: PendingSaveEnvelope): Promise<void> {
    const current = this.#pendingEnvelope;
    if (current && current.idempotencyKey !== envelope.idempotencyKey) {
      throw new Error('已有未确认保存信封，不能创建第二个信封');
    }
    this.#pendingEnvelope = envelope;
    if (this.options.initialError) return;
    try {
      await this.#enqueueWrite(() =>
        this.options.repository.setPending(this.options.scope, envelope),
      );
    } catch (error) {
      this.#reportError(error);
      throw error;
    }
  }

  async acknowledgePending(
    input: Omit<AcknowledgePendingInput, 'workingSnapshot' | 'localSeq'>,
  ): Promise<boolean> {
    const pending = this.#pendingEnvelope;
    if (
      !pending ||
      pending.idempotencyKey !== input.idempotencyKey ||
      pending.clientSeq !== input.clientSeq
    ) {
      return false;
    }

    if (!this.options.initialError) {
      try {
        await this.#enqueueWrite(async () => {
          const state = this.options.store.getState();
          const persisted = await this.options.repository.acknowledgePending(this.options.scope, {
            ...input,
            workingSnapshot: state.document,
            localSeq: state.localSeq,
          });
          if (!persisted) throw new LocalDraftUnavailableError('corrupt');
        });
      } catch (error) {
        this.#reportError(error);
      }
    }

    this.#baseRevision = input.revision;
    this.#baseSnapshot = input.baseSnapshot;
    this.#pendingEnvelope = null;
    return this.options.store.getState().acknowledge({
      clientSeq: input.clientSeq,
      revision: input.revision,
    });
  }

  async discardPending(idempotencyKey: string): Promise<boolean> {
    if (this.#pendingEnvelope?.idempotencyKey !== idempotencyKey) return false;
    this.#pendingEnvelope = null;
    if (this.options.initialError) return true;
    try {
      return await this.#enqueueWrite(async () => {
        await this.options.repository.discardPending(this.options.scope, idempotencyKey);
      }).then(() => true);
    } catch (error) {
      this.#reportError(error);
      return true;
    }
  }

  async adoptRemote(snapshot: RemoteResumeSnapshot): Promise<void> {
    if (snapshot.resumeId !== this.options.scope.resumeId) {
      throw new Error('远端快照不属于当前简历');
    }
    await this.#discardConflictPending();
    this.#baseRevision = snapshot.revision;
    this.#baseSnapshot = snapshot.document;
    this.options.store.getState().replaceFromRemote({
      document: snapshot.document,
      revision: snapshot.revision,
    });
    await this.flush();
  }

  async rebaseLocalOntoRemote(snapshot: RemoteResumeSnapshot): Promise<void> {
    if (snapshot.resumeId !== this.options.scope.resumeId) {
      throw new Error('远端快照不属于当前简历');
    }
    await this.#discardConflictPending();
    this.#baseRevision = snapshot.revision;
    this.#baseSnapshot = snapshot.document;
    const state = this.options.store.getState();
    this.options.store.getState().hydrateWorkingCopy({
      document: state.document,
      localSeq: state.localSeq,
      ackedSeq: state.ackedSeq,
      ackRevision: snapshot.revision,
    });
    await this.flush();
  }

  async #discardConflictPending(): Promise<void> {
    const pending = this.#pendingEnvelope;
    this.#pendingEnvelope = null;
    if (!pending || this.options.initialError) return;
    try {
      await this.#enqueueWrite(async () => {
        const discarded = await this.options.repository.discardPending(
          this.options.scope,
          pending.idempotencyKey,
        );
        if (!discarded) throw new LocalDraftUnavailableError('corrupt');
      });
    } catch (error) {
      this.#reportError(error);
    }
  }

  #reportError(error: unknown): void {
    const mapped =
      error instanceof LocalDraftUnavailableError
        ? error
        : new LocalDraftUnavailableError('unavailable', { cause: error });
    if (!this.#disposed) {
      this.options.onStatus({ phase: 'error', failureReason: mapped.reason });
    }
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    this.#disposed = true;
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    try {
      if (!this.options.initialError) {
        await this.#enqueueWrite(() => this.options.repository.put(this.#currentRecord()));
      }
    } catch {
      // 页面退出时只做尽力写入，不能把异步异常冒泡为未处理拒绝。
    } finally {
      this.options.repository.close();
    }
  }
}
