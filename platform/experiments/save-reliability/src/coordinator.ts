import { SaveError, type Envelope, type Receipt, type Snapshot } from './protocol.js';

export type Phase =
  'synced' | 'dirty' | 'saving' | 'retryWait' | 'conflict' | 'authPaused' | 'validationError';
export type Draft = {
  userId: string;
  resumeId: string;
  tabId: string;
  revision: string;
  baseSnapshot: Snapshot;
  document: Snapshot;
  localSeq: number;
  ackedSeq: number;
  pending: Envelope | null;
  phase: Phase;
};
export interface DraftStorage {
  write(key: string, draft: Draft): Promise<void>;
}
type Transport = (envelope: Envelope) => Promise<Receipt>;

/** Transport/storage ports: real HTTP and Dexie adapters are a later V0.1 gate. */
export class SaveCoordinator {
  private draft: Draft;
  private inFlight: Promise<void> | null = null;
  private storageTail: Promise<void> = Promise.resolve();
  private storageHealthy = true;

  constructor(
    draft: Draft,
    private readonly storage: DraftStorage,
    private readonly transport: Transport,
    private readonly makeKey: () => string,
  ) {
    this.draft = structuredClone(draft);
    // Interrupted network request resumes as uncertain, never as already synced.
    if (this.draft.pending && this.draft.phase === 'saving') this.draft.phase = 'retryWait';
  }
  snapshot(): Draft {
    return structuredClone(this.draft);
  }
  get localBackupAvailable(): boolean {
    return this.storageHealthy;
  }
  get storageKey(): string {
    return JSON.stringify([this.draft.userId, this.draft.resumeId, this.draft.tabId]);
  }

  edit(document: Snapshot): void {
    this.draft.document = structuredClone(document);
    this.draft.localSeq++;
    if (this.draft.phase === 'synced') this.draft.phase = 'dirty';
    void this.persist();
  }
  private persist(): Promise<void> {
    // Capture before awaiting: queued writes cannot finish out of order.
    const captured = this.snapshot();
    this.storageTail = this.storageTail.then(async () => {
      try {
        await this.storage.write(this.storageKey, captured);
        this.storageHealthy = true;
      } catch {
        this.storageHealthy = false;
      }
    });
    return this.storageTail;
  }
  async backupSettled(): Promise<void> {
    await this.storageTail;
  }

  flush(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (['conflict', 'authPaused', 'validationError'].includes(this.draft.phase))
      return Promise.resolve();
    this.inFlight = this.drain().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }
  private async drain(): Promise<void> {
    while (this.draft.pending || this.draft.localSeq > this.draft.ackedSeq) {
      this.draft.pending ??= {
        resumeId: this.draft.resumeId,
        key: this.makeKey(),
        baseRevision: this.draft.revision,
        clientSeq: this.draft.localSeq,
        document: structuredClone(this.draft.document),
      };
      const envelope = structuredClone(this.draft.pending);
      this.draft.phase = 'saving';
      await this.persist(); // On failure attempt online rescue, with separate local warning.
      try {
        const ack = await this.transport(structuredClone(envelope));
        if (
          ack.resumeId !== envelope.resumeId ||
          ack.acknowledgedSeq !== envelope.clientSeq ||
          ack.revision !== (BigInt(envelope.baseRevision) + 1n).toString()
        ) {
          throw new Error('INVALID_ACK');
        }
        this.draft.revision = ack.revision;
        this.draft.baseSnapshot = structuredClone(envelope.document);
        this.draft.ackedSeq = envelope.clientSeq;
        this.draft.pending = null;
        this.draft.phase = this.draft.localSeq === this.draft.ackedSeq ? 'synced' : 'dirty';
        // Never assign the server/old envelope document to the current editor.
        await this.persist();
      } catch (error) {
        const status = error instanceof SaveError ? error.status : 0;
        this.draft.phase =
          status === 412
            ? 'conflict'
            : status === 401
              ? 'authPaused'
              : [400, 403, 404, 409, 413, 422].includes(status)
                ? 'validationError'
                : 'retryWait';
        await this.persist();
        return; // Scheduling/backoff belongs to the adapter, not an infinite loop.
      }
    }
  }
  resumeAuthentication(userId: string): void {
    if (userId !== this.draft.userId) throw new SaveError('ACCOUNT_MISMATCH', 403);
    if (this.draft.phase === 'authPaused') this.draft.phase = 'retryWait';
  }
  resolveConflict(merged: Snapshot, remote: { revision: string; document: Snapshot }): void {
    if (this.draft.phase !== 'conflict') throw new SaveError('NOT_CONFLICTED', 409);
    // UI must retain/export the local branch and obtain explicit user confirmation.
    this.draft.revision = remote.revision;
    this.draft.baseSnapshot = structuredClone(remote.document);
    this.draft.pending = null;
    this.draft.document = structuredClone(merged);
    this.draft.localSeq++;
    this.draft.phase = 'dirty';
    void this.persist();
  }
}
