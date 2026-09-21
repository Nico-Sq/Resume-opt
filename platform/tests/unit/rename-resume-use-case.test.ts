import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  InvalidRenameResumeRequestError,
  RenameResume,
  type RenameResumeCommand,
  type RenameResumeResult,
  type UserTransactionManager,
} from '@resume/application';

const userId = '72000000-0000-4000-8000-000000000001';
const resumeId = '72000000-0000-4000-8000-000000000002';

function input(title: string) {
  return {
    resumeId,
    idempotencyKey: randomUUID(),
    baseRevision: '7',
    title,
    traceId: randomUUID(),
  };
}

function harness() {
  const rename = vi.fn<(command: RenameResumeCommand) => Promise<RenameResumeResult>>((command) =>
    Promise.resolve({
      receipt: {
        resume: {
          id: command.resumeId,
          title: command.title,
          locale: 'zh-CN',
          stage: 'student',
          revision: '8',
          templateId: 'ats-basic',
          templateVersion: '1.0.0',
          createdAt: '2026-09-21T00:00:00.000Z',
          updatedAt: '2026-09-21T01:00:00.000Z',
        },
        versionId: randomUUID(),
      },
      replayed: false,
    }),
  );
  const transactions: UserTransactionManager = {
    withUser(owner, work) {
      expect(owner).toBe(userId);
      return work({
        resumes: {
          copy: () => Promise.reject(new Error('本测试不调用复制')),
          create: () => Promise.reject(new Error('本测试不调用创建')),
          delete: () => Promise.reject(new Error('本测试不调用删除')),
          findActiveById: () => Promise.resolve(null),
          listActive: () => Promise.resolve([]),
          listDeleted: () => Promise.resolve([]),
          rename,
          saveDocument: () => Promise.reject(new Error('本测试不调用保存')),
          undelete: () => Promise.reject(new Error('本测试不调用恢复')),
        },
      });
    },
  };
  return {
    rename,
    useCase: new RenameResume({ requireIdentity: () => Promise.resolve({ userId }) }, transactions),
  };
}

describe('RenameResume', () => {
  it('derives ownership, trims the title and forwards the shared revision', async () => {
    const { rename, useCase } = harness();
    const result = await useCase.execute(input('  新名称  '));

    expect(rename).toHaveBeenCalledWith(expect.objectContaining({ title: '新名称' }));
    expect(result).toMatchObject({ resume: { title: '新名称', revision: '8' }, replayed: false });
  });

  it.each([
    ['', false],
    ['😀', true],
    ['😀'.repeat(200), true],
    ['😀'.repeat(201), false],
  ])('validates the 0/1/200/201 Unicode title boundary', async (title, accepted) => {
    const { rename, useCase } = harness();
    const promise = useCase.execute(input(title));
    if (accepted) await expect(promise).resolves.toMatchObject({ resume: { title } });
    else await expect(promise).rejects.toBeInstanceOf(InvalidRenameResumeRequestError);
    expect(rename).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });

  it('rejects extra ownership fields and unsafe revisions before a transaction', async () => {
    const { rename, useCase } = harness();
    await expect(
      useCase.execute({ ...input('新名称'), ownerId: randomUUID() } as Parameters<
        RenameResume['execute']
      >[0]),
    ).rejects.toBeInstanceOf(InvalidRenameResumeRequestError);
    await expect(useCase.execute({ ...input('新名称'), baseRevision: '0' })).rejects.toBeInstanceOf(
      InvalidRenameResumeRequestError,
    );
    expect(rename).not.toHaveBeenCalled();
  });
});
