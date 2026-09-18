import type {
  LocalDraftConflictContext,
  LocalDraftController,
  PendingSaveEnvelope,
  RemoteResumeSnapshot,
} from '../persistence';
import type { ResumeEditorStore } from '../store';
import {
  SaveTransportError,
  type SaveFailureKind,
  type SaveReceipt,
  type SaveTransport,
} from './http-save-transport';

export type SaveCoordinatorStatus =
  | { phase: 'synced'; revision: string; savedAt?: string }
  | { phase: 'dirty' }
  | { phase: 'debouncing' }
  | { phase: 'saving'; clientSeq: number; attempt: number }
  | { phase: 'retry-wait'; clientSeq: number; attempt: number; retryInMs: number }
  | {
      phase: 'failed';
      kind: SaveFailureKind;
      message: string;
      canRetry: boolean;
      traceId?: string;
    }
  | { phase: 'conflict'; currentRevision?: string; traceId?: string }
  | { phase: 'auth-paused'; traceId?: string }
  | { phase: 'validation-error'; message: string; clientSeq: number; traceId?: string };

export type SavePersistence = Pick<
  LocalDraftController,
  | 'flush'
  | 'getPendingEnvelope'
  | 'getConflictContext'
  | 'freezePending'
  | 'acknowledgePending'
  | 'discardPending'
  | 'adoptRemote'
  | 'rebaseLocalOntoRemote'
>;

export interface SaveCoordinatorOptions {
  resumeId: string;
  store: ResumeEditorStore;
  persistence: SavePersistence;
  transport: SaveTransport;
  onStatus: (status: SaveCoordinatorStatus) => void;
  debounceMs?: number;
  maxAutomaticRetries?: number;
  retryBaseMs?: number;
  now?: () => Date;
  random?: () => number;
  createIdempotencyKey?: () => string;
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} 必须是非负安全整数`);
  }
}

export class SaveCoordinator {
  readonly #debounceMs: number;
  readonly #maxAutomaticRetries: number;
  readonly #retryBaseMs: number;
  readonly #now: () => Date;
  readonly #random: () => number;
  readonly #createIdempotencyKey: () => string;
  #debounceTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #unsubscribe: (() => void) | null = null;
  #inFlight: Promise<void> | null = null;
  #abortController: AbortController | null = null;
  #retryCount = 0;
  #disposed = false;
  #started = false;
  #terminalPhase: SaveCoordinatorStatus['phase'] | null = null;
  #validationFailedSeq: number | null = null;

  constructor(private readonly options: SaveCoordinatorOptions) {
    this.#debounceMs = options.debounceMs ?? 800;
    this.#maxAutomaticRetries = options.maxAutomaticRetries ?? 3;
    this.#retryBaseMs = options.retryBaseMs ?? 1_000;
    this.#now = options.now ?? (() => new Date());
    this.#random = options.random ?? Math.random;
    this.#createIdempotencyKey = options.createIdempotencyKey ?? (() => crypto.randomUUID());
    assertNonNegativeInteger(this.#debounceMs, '保存防抖时间');
    assertNonNegativeInteger(this.#maxAutomaticRetries, '自动重试次数');
    assertNonNegativeInteger(this.#retryBaseMs, '重试基础等待时间');
  }

  start(): void {
    if (this.#started) throw new Error('保存协调器不能重复启动');
    this.#started = true;
    this.#unsubscribe = this.options.store.subscribe(
      (state) => ({ localSeq: state.localSeq, ackedSeq: state.ackedSeq }),
      ({ localSeq, ackedSeq }) => {
        this.#handleStoreChange(localSeq, ackedSeq);
      },
      {
        equalityFn: (left, right) =>
          left.localSeq === right.localSeq && left.ackedSeq === right.ackedSeq,
      },
    );

    const pending = this.options.persistence.getPendingEnvelope();
    if (pending) {
      this.options.onStatus({ phase: 'dirty' });
      void this.#requestSave();
      return;
    }
    const state = this.options.store.getState();
    if (state.localSeq > state.ackedSeq) this.#scheduleDebounce();
    else this.options.onStatus({ phase: 'synced', revision: state.ackRevision });
  }

  #handleStoreChange(localSeq: number, ackedSeq: number): void {
    if (this.#disposed) return;
    if (
      this.#terminalPhase === 'validation-error' &&
      this.#validationFailedSeq !== null &&
      localSeq > this.#validationFailedSeq
    ) {
      this.#terminalPhase = null;
      this.#validationFailedSeq = null;
    }
    if (localSeq <= ackedSeq && !this.options.persistence.getPendingEnvelope()) {
      if (!this.#inFlight) {
        this.options.onStatus({
          phase: 'synced',
          revision: this.options.store.getState().ackRevision,
        });
      }
      return;
    }
    if (this.#terminalPhase || this.#inFlight || this.#retryTimer) return;
    this.#scheduleDebounce();
  }

  #scheduleDebounce(): void {
    if (this.#disposed || this.#terminalPhase) return;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    this.options.onStatus({ phase: 'debouncing' });
    this.#debounceTimer = setTimeout(() => {
      this.#debounceTimer = null;
      void this.#requestSave();
    }, this.#debounceMs);
  }

  #createEnvelope(): PendingSaveEnvelope | null {
    const state = this.options.store.getState();
    if (state.localSeq <= state.ackedSeq) return null;
    return {
      idempotencyKey: this.#createIdempotencyKey(),
      resumeId: this.options.resumeId,
      baseRevision: state.ackRevision,
      clientSeq: state.localSeq,
      document: state.document,
      createdAt: this.#now().toISOString(),
    };
  }

  async #prepareEnvelope(): Promise<PendingSaveEnvelope | null> {
    const existing = this.options.persistence.getPendingEnvelope();
    if (existing) return existing;
    const envelope = this.#createEnvelope();
    if (!envelope) return null;
    try {
      await this.options.persistence.flush();
    } catch {
      // 本地备份控制器会独立报告故障；在线保存仍作为救援路径继续。
    }
    try {
      await this.options.persistence.freezePending(envelope);
    } catch {
      // IndexedDB 不可用时仍尝试在线保存，但界面继续显示本地持久化警告。
    }
    return envelope;
  }

  async #requestSave(): Promise<void> {
    if (this.#disposed || this.#terminalPhase) return;
    if (this.#retryTimer) return;
    if (this.#inFlight) return this.#inFlight;
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }

    const operation = this.#performSave();
    this.#inFlight = operation;
    try {
      await operation;
    } finally {
      if (this.#inFlight === operation) this.#inFlight = null;
      this.#abortController = null;
      if (this.#canContinueImmediately() && this.options.store.getState().isDirty) {
        void this.#requestSave();
      }
    }
  }

  #canContinueImmediately(): boolean {
    return !this.#disposed && this.#terminalPhase === null && this.#retryTimer === null;
  }

  async #performSave(): Promise<void> {
    const envelope = await this.#prepareEnvelope();
    if (!envelope || this.#disposed) return;
    const attempt = this.#retryCount + 1;
    this.options.onStatus({ phase: 'saving', clientSeq: envelope.clientSeq, attempt });
    const abortController = new AbortController();
    this.#abortController = abortController;
    try {
      const receipt = await this.options.transport.save(envelope, abortController.signal);
      await this.#acknowledge(envelope, receipt);
    } catch (error) {
      this.#handleFailure(envelope, error);
    }
  }

  async #acknowledge(envelope: PendingSaveEnvelope, receipt: SaveReceipt): Promise<void> {
    const acknowledged = await this.options.persistence.acknowledgePending({
      idempotencyKey: envelope.idempotencyKey,
      revision: receipt.revision,
      clientSeq: receipt.acknowledgedSeq,
      baseSnapshot: envelope.document,
    });
    if (!acknowledged) {
      this.#terminalPhase = 'failed';
      this.options.onStatus({
        phase: 'failed',
        kind: 'fatal',
        message: '保存回执无法匹配当前待确认请求',
        canRetry: false,
      });
      return;
    }
    this.#retryCount = 0;
    const state = this.options.store.getState();
    if (state.localSeq > state.ackedSeq) {
      this.options.onStatus({ phase: 'dirty' });
    } else {
      this.options.onStatus({
        phase: 'synced',
        revision: receipt.revision,
        savedAt: receipt.savedAt,
      });
    }
  }

  #handleFailure(envelope: PendingSaveEnvelope, error: unknown): void {
    const failure =
      error instanceof SaveTransportError
        ? error
        : new SaveTransportError('network', '无法连接保存服务', { cause: error });
    if (failure.kind === 'aborted' && this.#disposed) return;
    if (failure.kind === 'network' || failure.kind === 'retryable') {
      if (this.#retryCount < this.#maxAutomaticRetries) {
        this.#retryCount += 1;
        const retryInMs = Math.round(
          this.#retryBaseMs * 2 ** (this.#retryCount - 1) * (0.8 + this.#random() * 0.4),
        );
        this.options.onStatus({
          phase: 'retry-wait',
          clientSeq: envelope.clientSeq,
          attempt: this.#retryCount,
          retryInMs,
        });
        this.#retryTimer = setTimeout(() => {
          this.#retryTimer = null;
          void this.#requestSave();
        }, retryInMs);
        return;
      }
      this.#terminalPhase = 'failed';
      this.options.onStatus({
        phase: 'failed',
        kind: failure.kind,
        message: failure.message,
        canRetry: true,
        ...(failure.options.traceId ? { traceId: failure.options.traceId } : {}),
      });
      return;
    }
    if (failure.kind === 'conflict') {
      this.#terminalPhase = 'conflict';
      this.options.onStatus({
        phase: 'conflict',
        ...(failure.options.currentRevision
          ? { currentRevision: failure.options.currentRevision }
          : {}),
        ...(failure.options.traceId ? { traceId: failure.options.traceId } : {}),
      });
      return;
    }
    if (failure.kind === 'auth') {
      this.#terminalPhase = 'auth-paused';
      this.options.onStatus({
        phase: 'auth-paused',
        ...(failure.options.traceId ? { traceId: failure.options.traceId } : {}),
      });
      return;
    }
    if (failure.kind === 'validation') {
      void this.options.persistence.discardPending(envelope.idempotencyKey);
      this.#terminalPhase = 'validation-error';
      this.#validationFailedSeq = envelope.clientSeq;
      this.options.onStatus({
        phase: 'validation-error',
        message: failure.message,
        clientSeq: envelope.clientSeq,
        ...(failure.options.traceId ? { traceId: failure.options.traceId } : {}),
      });
      return;
    }
    this.#terminalPhase = 'failed';
    this.options.onStatus({
      phase: 'failed',
      kind: failure.kind,
      message: failure.message,
      canRetry: false,
      ...(failure.options.traceId ? { traceId: failure.options.traceId } : {}),
    });
  }

  async flush(): Promise<void> {
    if (this.#disposed) return;
    if (this.#debounceTimer) {
      clearTimeout(this.#debounceTimer);
      this.#debounceTimer = null;
    }
    await this.#requestSave();
  }

  async retryNow(): Promise<void> {
    if (this.#disposed) return;
    if (this.#retryTimer) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    this.#terminalPhase = null;
    this.#validationFailedSeq = null;
    this.#retryCount = 0;
    await this.#requestSave();
  }

  getConflictContext(): LocalDraftConflictContext | null {
    if (this.#terminalPhase !== 'conflict') return null;
    return this.options.persistence.getConflictContext();
  }

  async adoptRemote(snapshot: RemoteResumeSnapshot): Promise<boolean> {
    if (this.#disposed || this.#terminalPhase !== 'conflict') return false;
    await this.options.persistence.adoptRemote(snapshot);
    this.#terminalPhase = null;
    this.#retryCount = 0;
    this.options.onStatus({ phase: 'synced', revision: snapshot.revision });
    return true;
  }

  async rebaseLocalOntoRemote(snapshot: RemoteResumeSnapshot): Promise<boolean> {
    if (this.#disposed || this.#terminalPhase !== 'conflict') return false;
    await this.options.persistence.rebaseLocalOntoRemote(snapshot);
    this.#terminalPhase = null;
    this.#retryCount = 0;
    this.options.onStatus({ phase: 'dirty' });
    await this.#requestSave();
    return true;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe?.();
    this.#unsubscribe = null;
    if (this.#debounceTimer) clearTimeout(this.#debounceTimer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#debounceTimer = null;
    this.#retryTimer = null;
    this.#abortController?.abort();
    this.#abortController = null;
  }
}
