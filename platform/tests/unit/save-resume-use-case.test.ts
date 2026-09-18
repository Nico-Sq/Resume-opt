import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  InvalidSaveRequestError,
  SaveResumeDocument,
  type SaveResumeCommand,
  type UserTransactionManager,
} from '@resume/application';
import { createInitialResumeDocument, type ResumeDocumentV1 } from '@resume/domain/resume';

const userId = '50000000-0000-4000-8000-000000000001';
const resumeId = '50000000-0000-4000-8000-000000000002';

function validInput() {
  return {
    resumeId,
    idempotencyKey: randomUUID(),
    baseRevision: '7',
    clientSeq: 18,
    document: createInitialResumeDocument(),
    traceId: randomUUID(),
  };
}

describe('SaveResumeDocument', () => {
  it('derives the owner from identity and passes one validated snapshot to the transaction', async () => {
    const saveDocument = vi.fn<(command: SaveResumeCommand) => Promise<never>>(() =>
      Promise.reject(new Error('stop after observing command')),
    );
    const observedUsers: string[] = [];
    const transactions: UserTransactionManager = {
      async withUser(currentUserId, work) {
        observedUsers.push(currentUserId);
        return work({
          resumes: {
            findActiveById: () => Promise.resolve(null),
            saveDocument,
          },
        });
      },
    };
    const useCase = new SaveResumeDocument(
      { requireIdentity: () => Promise.resolve({ userId }) },
      transactions,
    );
    const input = validInput();

    await expect(useCase.execute(input)).rejects.toThrow('stop after observing command');

    expect(observedUsers).toEqual([userId]);
    expect(saveDocument).toHaveBeenCalledWith(input);
  });

  it('rejects invalid documents before opening a transaction', async () => {
    let transactionCalled = false;
    const transactions: UserTransactionManager = {
      withUser<T>(): Promise<T> {
        transactionCalled = true;
        return Promise.reject(new Error('不应开启事务'));
      },
    };
    const useCase = new SaveResumeDocument(
      { requireIdentity: () => Promise.resolve({ userId }) },
      transactions,
    );

    await expect(
      useCase.execute({
        ...validInput(),
        document: { schemaVersion: 99 } as unknown as ResumeDocumentV1,
      }),
    ).rejects.toBeInstanceOf(InvalidSaveRequestError);
    expect(transactionCalled).toBe(false);
  });

  it('rejects unsafe client sequence and revision values', async () => {
    const transactions: UserTransactionManager = {
      withUser<T>(): Promise<T> {
        return Promise.reject(new Error('不应开启事务'));
      },
    };
    const useCase = new SaveResumeDocument(
      { requireIdentity: () => Promise.resolve({ userId }) },
      transactions,
    );

    await expect(
      useCase.execute({ ...validInput(), clientSeq: Number.MAX_SAFE_INTEGER + 1 }),
    ).rejects.toBeInstanceOf(InvalidSaveRequestError);
    await expect(
      useCase.execute({ ...validInput(), baseRevision: '9223372036854775808' }),
    ).rejects.toBeInstanceOf(InvalidSaveRequestError);
  });
});
