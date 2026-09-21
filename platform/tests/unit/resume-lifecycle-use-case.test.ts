import { describe, expect, it, vi } from 'vitest';

import {
  DeleteResume,
  InvalidDeletedResumeCursorError,
  InvalidResumeLifecycleRequestError,
  ListDeletedResumes,
  UndeleteResume,
  type DeleteResumeResult,
  type DeletedResumeMetadataRecord,
  type UndeleteResumeResult,
  type UserTransactionManager,
} from '@resume/application';

const userId = '76000000-0000-4000-8000-000000000001';
const resumeId = '76000000-0000-4000-8000-000000000002';

function harness(deleted: DeletedResumeMetadataRecord[] = []) {
  const deleteResult: DeleteResumeResult = {
    receipt: {
      id: resumeId,
      revision: '2',
      deletedAt: '2026-09-22T00:00:00.000Z',
      restoreUntil: '2026-09-29T00:00:00.000Z',
      versionId: '76000000-0000-4000-8000-000000000003',
    },
    replayed: false,
  };
  const undeleteResult: UndeleteResumeResult = {
    receipt: {
      resume: {
        id: resumeId,
        title: '恢复的简历',
        locale: 'zh-CN',
        stage: 'student',
        revision: '3',
        templateId: 'ats-basic',
        templateVersion: '1.0.0',
        createdAt: '2026-09-21T00:00:00.000Z',
        updatedAt: '2026-09-22T00:01:00.000Z',
      },
      versionId: '76000000-0000-4000-8000-000000000004',
    },
    replayed: false,
  };
  const remove = vi.fn(() => Promise.resolve(deleteResult));
  const undelete = vi.fn(() => Promise.resolve(undeleteResult));
  const listDeleted = vi.fn(() => Promise.resolve(deleted));
  const transactions: UserTransactionManager = {
    withUser(owner, work) {
      expect(owner).toBe(userId);
      return work({
        resumes: {
          copy: () => Promise.reject(new Error('本测试不调用复制')),
          create: () => Promise.reject(new Error('本测试不调用创建')),
          delete: remove,
          findActiveById: () => Promise.resolve(null),
          listActive: () => Promise.resolve([]),
          listDeleted,
          rename: () => Promise.reject(new Error('本测试不调用重命名')),
          saveDocument: () => Promise.reject(new Error('本测试不调用保存')),
          undelete,
        },
      });
    },
  };
  const identity = { requireIdentity: () => Promise.resolve({ userId }) };
  return {
    remove,
    undelete,
    listDeleted,
    deleteUseCase: new DeleteResume(identity, transactions),
    restoreUseCase: new UndeleteResume(identity, transactions),
    listUseCase: new ListDeletedResumes(identity, transactions),
  };
}

describe('resume lifecycle use cases', () => {
  it('requires explicit confirmation and forwards CAS lifecycle commands', async () => {
    const current = harness();
    const common = {
      resumeId,
      idempotencyKey: '76000000-0000-4000-8000-000000000005',
      baseRevision: '1',
      traceId: '76000000-0000-4000-8000-000000000006',
    };
    await expect(
      current.deleteUseCase.execute({ ...common, confirm: false as true }),
    ).rejects.toBeInstanceOf(InvalidResumeLifecycleRequestError);
    await expect(
      current.deleteUseCase.execute({ ...common, confirm: true }),
    ).resolves.toMatchObject({
      id: resumeId,
      revision: '2',
    });
    await expect(
      current.restoreUseCase.execute({ ...common, baseRevision: '2' }),
    ).resolves.toMatchObject({ resume: { revision: '3' } });
    expect(current.remove).toHaveBeenCalledWith(common);
  });

  it('paginates deleted metadata and binds cursors to the account', async () => {
    const records: DeletedResumeMetadataRecord[] = Array.from({ length: 2 }, (_, index) => ({
      id: `76000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`,
      title: `已删除 ${String(index)}`,
      locale: 'zh-CN',
      stage: 'student',
      revision: 2n,
      templateId: 'ats-basic',
      templateVersion: '1.0.0',
      createdAt: new Date('2026-09-20T00:00:00.000Z'),
      updatedAt: new Date('2026-09-22T00:00:00.000Z'),
      deletedAt: new Date(`2026-09-22T00:00:0${String(1 - index)}.000Z`),
      restoreUntil: new Date('2026-09-29T00:00:00.000Z'),
    }));
    const current = harness(records);
    const page = await current.listUseCase.execute({ limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeTypeOf('string');
    expect(current.listDeleted).toHaveBeenCalledWith({ limit: 2 });

    const cursor = Buffer.from(
      JSON.stringify({
        version: 1,
        list: 'deleted-resumes',
        userId: '76000000-0000-4000-8000-000000000099',
        deletedAt: '2026-09-22T00:00:01.000Z',
        id: records[0]?.id,
      }),
    ).toString('base64url');
    await expect(current.listUseCase.execute({ cursor })).rejects.toBeInstanceOf(
      InvalidDeletedResumeCursorError,
    );
  });
});
