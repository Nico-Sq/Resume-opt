import type { ResumeDocumentV1 } from '@resume/domain/resume';
import Dexie, { type Table } from 'dexie';

import {
  hasUnsyncedLocalChanges,
  LocalDraftRecordSchema,
  parseLocalDraftRecord,
  parseLocalDraftScope,
  type LocalDraftRecord,
  type LocalDraftRescueExport,
  type LocalDraftScope,
  type PendingSaveEnvelope,
} from './local-draft-schema';

const DEFAULT_DATABASE_NAME = 'resume-opt-local-drafts-v1';

export type LocalDraftFailureReason = 'quota' | 'private-mode' | 'corrupt' | 'unavailable';

export class LocalDraftUnavailableError extends Error {
  constructor(
    readonly reason: LocalDraftFailureReason,
    options?: ErrorOptions,
  ) {
    super('本地草稿存储不可用', options);
    this.name = 'LocalDraftUnavailableError';
  }
}

export class UnsyncedDraftsError extends Error {
  constructor(
    readonly unsyncedCount: number,
    readonly rescueJson: string,
  ) {
    super('账户仍有未同步的本地草稿');
    this.name = 'UnsyncedDraftsError';
  }
}

interface ResumeDraftDatabase extends Dexie {
  drafts: Table<LocalDraftRecord, [string, string, string]>;
}

export interface ClearAccountOptions {
  rescueConfirmed?: boolean;
}

export interface AcknowledgePendingInput {
  idempotencyKey: string;
  revision: string;
  clientSeq: number;
  baseSnapshot: ResumeDocumentV1;
}

export interface LocalDraftRepository {
  get(scope: LocalDraftScope): Promise<LocalDraftRecord | null>;
  put(record: LocalDraftRecord): Promise<void>;
  setPending(scope: LocalDraftScope, envelope: PendingSaveEnvelope): Promise<void>;
  acknowledgePending(scope: LocalDraftScope, input: AcknowledgePendingInput): Promise<boolean>;
  exportAccountRescue(userId: string): Promise<string>;
  clearAccount(userId: string, options?: ClearAccountOptions): Promise<number>;
  delete(scope: LocalDraftScope): Promise<void>;
  close(): void;
}

function mapStorageError(error: unknown): LocalDraftUnavailableError {
  if (error instanceof LocalDraftUnavailableError) return error;
  const name = error instanceof Error ? error.name : '';
  const innerName =
    typeof error === 'object' && error !== null && 'inner' in error
      ? (error.inner as { name?: unknown }).name
      : undefined;
  const names = new Set([name, typeof innerName === 'string' ? innerName : '']);
  if (names.has('QuotaExceededError')) {
    return new LocalDraftUnavailableError('quota', { cause: error });
  }
  if (names.has('SecurityError')) {
    return new LocalDraftUnavailableError('private-mode', { cause: error });
  }
  if (
    [
      'DatabaseClosedError',
      'InvalidStateError',
      'MissingAPIError',
      'OpenFailedError',
      'UnknownError',
    ].some((candidate) => names.has(candidate))
  ) {
    return new LocalDraftUnavailableError('unavailable', { cause: error });
  }
  return new LocalDraftUnavailableError('unavailable', { cause: error });
}

function parseStoredRecord(record: LocalDraftRecord): LocalDraftRecord {
  const parsed = LocalDraftRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new LocalDraftUnavailableError('corrupt', { cause: parsed.error });
  }
  return parsed.data;
}

function rescueJson(userId: string, records: LocalDraftRecord[], now: () => Date): string {
  const payload: LocalDraftRescueExport = {
    format: 'resume-opt-local-draft-rescue',
    formatVersion: 1,
    userId,
    exportedAt: now().toISOString(),
    drafts: records.map(parseStoredRecord),
  };
  return JSON.stringify(payload, null, 2);
}

export class DexieLocalDraftRepository implements LocalDraftRepository {
  readonly #database: ResumeDraftDatabase;

  constructor(
    databaseName = DEFAULT_DATABASE_NAME,
    private readonly now: () => Date = () => new Date(),
  ) {
    const database = new Dexie(databaseName) as ResumeDraftDatabase;
    database.version(1).stores({
      drafts: '[userId+resumeId+tabId], [userId+resumeId], userId, updatedAt',
    });
    this.#database = database;
  }

  async #run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof UnsyncedDraftsError) throw error;
      if (error instanceof LocalDraftUnavailableError) throw error;
      throw mapStorageError(error);
    }
  }

  async get(scope: LocalDraftScope): Promise<LocalDraftRecord | null> {
    const parsedScope = parseLocalDraftScope(scope);
    return this.#run(async () => {
      const record = await this.#database.drafts.get([
        parsedScope.userId,
        parsedScope.resumeId,
        parsedScope.tabId,
      ]);
      if (!record) return null;
      return parseStoredRecord(record);
    });
  }

  async put(record: LocalDraftRecord): Promise<void> {
    const parsed = parseLocalDraftRecord(record);
    await this.#run(async () => {
      await this.#database.drafts.put(parsed);
    });
  }

  async setPending(scope: LocalDraftScope, envelope: PendingSaveEnvelope): Promise<void> {
    const parsedScope = parseLocalDraftScope(scope);
    await this.#run(async () => {
      await this.#database.transaction('rw', this.#database.drafts, async () => {
        const current = await this.#database.drafts.get([
          parsedScope.userId,
          parsedScope.resumeId,
          parsedScope.tabId,
        ]);
        if (!current) throw new LocalDraftUnavailableError('corrupt');
        await this.#database.drafts.put(
          parseLocalDraftRecord({
            ...current,
            pendingEnvelope: envelope,
            updatedAt: this.now().toISOString(),
          }),
        );
      });
    });
  }

  async acknowledgePending(
    scope: LocalDraftScope,
    input: AcknowledgePendingInput,
  ): Promise<boolean> {
    const parsedScope = parseLocalDraftScope(scope);
    return this.#run(() =>
      this.#database.transaction('rw', this.#database.drafts, async () => {
        const current = await this.#database.drafts.get([
          parsedScope.userId,
          parsedScope.resumeId,
          parsedScope.tabId,
        ]);
        if (!current?.pendingEnvelope) return false;
        if (
          current.pendingEnvelope.idempotencyKey !== input.idempotencyKey ||
          current.pendingEnvelope.clientSeq !== input.clientSeq
        ) {
          return false;
        }
        await this.#database.drafts.put(
          parseLocalDraftRecord({
            ...current,
            baseRevision: input.revision,
            baseSnapshot: input.baseSnapshot,
            ackedSeq: input.clientSeq,
            pendingEnvelope: null,
            updatedAt: this.now().toISOString(),
          }),
        );
        return true;
      }),
    );
  }

  async exportAccountRescue(userId: string): Promise<string> {
    const parsedUserId = parseLocalDraftScope({
      userId,
      resumeId: '00000000-0000-4000-8000-000000000000',
      tabId: '00000000-0000-4000-8000-000000000000',
    }).userId;
    return this.#run(async () => {
      const records = await this.#database.drafts.where('userId').equals(parsedUserId).toArray();
      return rescueJson(parsedUserId, records, this.now);
    });
  }

  async clearAccount(userId: string, options: ClearAccountOptions = {}): Promise<number> {
    const parsedUserId = parseLocalDraftScope({
      userId,
      resumeId: '00000000-0000-4000-8000-000000000000',
      tabId: '00000000-0000-4000-8000-000000000000',
    }).userId;
    return this.#run(() =>
      this.#database.transaction('rw', this.#database.drafts, async () => {
        const records = (
          await this.#database.drafts.where('userId').equals(parsedUserId).toArray()
        ).map(parseStoredRecord);
        const unsynced = records.filter(hasUnsyncedLocalChanges);
        if (unsynced.length > 0 && !options.rescueConfirmed) {
          throw new UnsyncedDraftsError(
            unsynced.length,
            rescueJson(parsedUserId, records, this.now),
          );
        }
        return this.#database.drafts.where('userId').equals(parsedUserId).delete();
      }),
    );
  }

  async delete(scope: LocalDraftScope): Promise<void> {
    const parsedScope = parseLocalDraftScope(scope);
    await this.#run(async () => {
      await this.#database.drafts.delete([
        parsedScope.userId,
        parsedScope.resumeId,
        parsedScope.tabId,
      ]);
    });
  }

  close(): void {
    this.#database.close();
  }
}

export function classifyLocalDraftError(error: unknown): LocalDraftUnavailableError {
  return mapStorageError(error);
}
