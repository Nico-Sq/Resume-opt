import { describe, expect, it } from 'vitest';

import {
  GetResumeForEditor,
  ResourceNotFoundError,
  StoredResumeInvalidError,
  type IdentityProvider,
  type PersistedResume,
  type UserTransactionManager,
} from '@resume/application';
import { createInitialResumeDocument } from '@resume/domain/resume';
import { FixedIdentityProvider } from '@resume/infrastructure/fixed-identity';

const userId = '00000000-0000-4000-8000-000000000001';
const resumeId = '00000000-0000-4000-8000-000000000002';

function persisted(document: unknown): PersistedResume {
  return {
    id: resumeId,
    userId,
    title: '测试简历',
    document,
    revision: 7n,
    schemaVersion: 1,
    templateId: 'ats-basic',
    templateVersion: '1.0.0',
    updatedAt: new Date('2026-09-17T00:00:00.000Z'),
  };
}

function transactionsFor(result: PersistedResume | null, observedUsers: string[]) {
  return {
    async withUser<T>(
      currentUserId: string,
      work: Parameters<UserTransactionManager['withUser']>[1],
    ): Promise<T> {
      observedUsers.push(currentUserId);
      return (await work({
        resumes: { findActiveById: () => Promise.resolve(result) },
      })) as T;
    },
  } satisfies UserTransactionManager;
}

describe('GetResumeForEditor', () => {
  it('derives ownership only from the identity provider and serializes revision safely', async () => {
    const observedUsers: string[] = [];
    const identity: IdentityProvider = { requireIdentity: () => Promise.resolve({ userId }) };
    const useCase = new GetResumeForEditor(
      identity,
      transactionsFor(persisted(createInitialResumeDocument()), observedUsers),
    );

    const result = await useCase.execute(resumeId);

    expect(observedUsers).toEqual([userId]);
    expect(result.id).toBe(resumeId);
    expect(result.revision).toBe('7');
    expect(result.document.schemaVersion).toBe(1);
  });

  it('returns one non-enumerating not-found error for invisible resources', async () => {
    const useCase = new GetResumeForEditor(
      { requireIdentity: () => Promise.resolve({ userId }) },
      transactionsFor(null, []),
    );

    await expect(useCase.execute(resumeId)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('rejects a corrupted stored document instead of returning partial data', async () => {
    const useCase = new GetResumeForEditor(
      { requireIdentity: () => Promise.resolve({ userId }) },
      transactionsFor(persisted({ schemaVersion: 99 }), []),
    );

    await expect(useCase.execute(resumeId)).rejects.toBeInstanceOf(StoredResumeInvalidError);
  });
});

describe('FixedIdentityProvider', () => {
  it('is available for local tests without accepting request data', async () => {
    const provider = new FixedIdentityProvider({ appEnvironment: 'local', userId });
    await expect(provider.requireIdentity()).resolves.toEqual({ userId });
  });

  it('fails closed in staging and production', () => {
    expect(() => new FixedIdentityProvider({ appEnvironment: 'production', userId })).toThrow(
      '固定测试身份只能用于 local/test',
    );
  });
});
