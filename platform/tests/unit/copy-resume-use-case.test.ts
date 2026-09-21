import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  CopyResume,
  InvalidCopyResumeRequestError,
  type CopyResumeCommand,
  type CopyResumeResult,
  type UserTransactionManager,
} from '@resume/application';
import { createInitialResumeDocument } from '@resume/domain/resume';

const userId = '52000000-0000-4000-8000-000000000001';

function harness() {
  const document = createInitialResumeDocument();
  const copy = vi.fn<(command: CopyResumeCommand) => Promise<CopyResumeResult>>((command) =>
    Promise.resolve({
      resume: {
        id: command.targetResumeId,
        userId,
        title: command.title,
        document,
        revision: 1n,
        schemaVersion: 1,
        templateId: document.templateId,
        templateVersion: document.templateVersion,
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
      },
      receipt: { resumeId: command.targetResumeId, revision: '1', versionId: randomUUID() },
      replayed: false,
    }),
  );
  const transactions: UserTransactionManager = {
    withUser(currentUserId, work) {
      expect(currentUserId).toBe(userId);
      return work({
        resumes: {
          copy,
          create: () => Promise.reject(new Error('本测试不调用创建')),
          findActiveById: () => Promise.resolve(null),
          listActive: () => Promise.resolve([]),
          rename: () => Promise.reject(new Error('本测试不调用重命名')),
          saveDocument: () => Promise.reject(new Error('本测试不调用保存')),
        },
      });
    },
  };
  return {
    copy,
    useCase: new CopyResume({ requireIdentity: () => Promise.resolve({ userId }) }, transactions),
  };
}

describe('CopyResume', () => {
  it('normalizes the title and delegates a fresh target ID for the current owner', async () => {
    const { copy, useCase } = harness();
    const sourceResumeId = randomUUID();
    const result = await useCase.execute({
      sourceResumeId,
      sourceRevision: '7',
      idempotencyKey: randomUUID(),
      title: '  岗位定制副本  ',
      traceId: randomUUID(),
    });
    const command = copy.mock.calls[0]?.[0];
    if (!command) throw new Error('未观察到复制命令');

    expect(command).toMatchObject({
      sourceResumeId,
      sourceRevision: '7',
      title: '岗位定制副本',
    });
    expect(command.targetResumeId).not.toBe(sourceResumeId);
    expect(result.resume).toMatchObject({
      id: command.targetResumeId,
      title: '岗位定制副本',
      revision: '1',
    });
  });

  it('rejects invalid revision, title and extra ownership fields before a transaction', async () => {
    const { copy, useCase } = harness();
    const base = {
      sourceResumeId: randomUUID(),
      sourceRevision: '1',
      idempotencyKey: randomUUID(),
      title: '副本',
      traceId: randomUUID(),
    };

    await expect(useCase.execute({ ...base, sourceRevision: '0' })).rejects.toBeInstanceOf(
      InvalidCopyResumeRequestError,
    );
    await expect(useCase.execute({ ...base, title: '' })).rejects.toBeInstanceOf(
      InvalidCopyResumeRequestError,
    );
    await expect(
      useCase.execute({ ...base, ownerId: randomUUID() } as Parameters<CopyResume['execute']>[0]),
    ).rejects.toBeInstanceOf(InvalidCopyResumeRequestError);
    expect(copy).not.toHaveBeenCalled();
  });
});
