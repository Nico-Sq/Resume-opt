import { describe, expect, it, vi } from 'vitest';

import {
  InvalidResumeCursorError,
  InvalidResumeListRequestError,
  ListResumes,
  type ResumeListQuery,
  type ResumeMetadataRecord,
  type UserTransactionManager,
} from '@resume/application';

const userId = '71000000-0000-4000-8000-000000000001';

function record(id: string, updatedAt = '2026-09-21T08:00:00.000Z'): ResumeMetadataRecord {
  return {
    id,
    title: `简历 ${id.at(-1) ?? ''}`,
    locale: 'zh-CN',
    stage: 'student',
    revision: 7n,
    templateId: 'ats-basic',
    templateVersion: '1.0.0',
    createdAt: new Date('2026-09-20T08:00:00.000Z'),
    updatedAt: new Date(updatedAt),
  };
}

function harness(records: ResumeMetadataRecord[], currentUserId = userId) {
  const listActive = vi.fn<(query: ResumeListQuery) => Promise<ResumeMetadataRecord[]>>(() =>
    Promise.resolve(records),
  );
  const transactions: UserTransactionManager = {
    withUser(owner, work) {
      expect(owner).toBe(currentUserId);
      return work({
        resumes: {
          copy: () => Promise.reject(new Error('本测试不调用复制')),
          create: () => Promise.reject(new Error('本测试不调用创建')),
          delete: () => Promise.reject(new Error('本测试不调用删除')),
          findActiveById: () => Promise.resolve(null),
          listActive,
          listDeleted: () => Promise.resolve([]),
          rename: () => Promise.reject(new Error('本测试不调用重命名')),
          saveDocument: () => Promise.reject(new Error('本测试不调用保存')),
          undelete: () => Promise.reject(new Error('本测试不调用恢复')),
        },
      });
    },
  };
  return {
    listActive,
    useCase: new ListResumes(
      { requireIdentity: () => Promise.resolve({ userId: currentUserId }) },
      transactions,
    ),
  };
}

describe('ListResumes', () => {
  it('returns only metadata, defaults to 20 and emits a stable next cursor', async () => {
    const records = Array.from({ length: 21 }, (_, index) =>
      record(`71000000-0000-4000-8000-${String(index + 2).padStart(12, '0')}`),
    );
    const { listActive, useCase } = harness(records);

    const result = await useCase.execute();
    const first = records[0];
    if (!first) throw new Error('缺少测试记录');

    expect(listActive).toHaveBeenCalledWith({ limit: 21 });
    expect(result.items).toHaveLength(20);
    expect(result.nextCursor).toBeTypeOf('string');
    expect(result.items[0]).toEqual({
      id: first.id,
      title: first.title,
      locale: 'zh-CN',
      stage: 'student',
      revision: '7',
      templateId: 'ats-basic',
      templateVersion: '1.0.0',
      createdAt: '2026-09-20T08:00:00.000Z',
      updatedAt: '2026-09-21T08:00:00.000Z',
    });
    expect(result.items[0]).not.toHaveProperty('document');
  });

  it('passes the decoded boundary and rejects malformed or cross-account cursors', async () => {
    const first = harness([
      record('71000000-0000-4000-8000-000000000003'),
      record('71000000-0000-4000-8000-000000000002'),
    ]);
    const page = await first.useCase.execute({ limit: 1 });
    if (!page.nextCursor) throw new Error('未生成测试游标');

    await first.useCase.execute({ cursor: page.nextCursor, limit: 1 });
    expect(first.listActive).toHaveBeenLastCalledWith({
      limit: 2,
      after: {
        updatedAt: new Date('2026-09-21T08:00:00.000Z'),
        id: '71000000-0000-4000-8000-000000000003',
      },
    });
    await expect(first.useCase.execute({ cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
      InvalidResumeCursorError,
    );
    await expect(
      harness([], '71000000-0000-4000-8000-000000000099').useCase.execute({
        cursor: page.nextCursor,
      }),
    ).rejects.toBeInstanceOf(InvalidResumeCursorError);
  });

  it.each([0, 101, 1.5, Number.NaN])(
    'rejects invalid limit %s before a transaction',
    async (limit) => {
      const { listActive, useCase } = harness([]);
      await expect(useCase.execute({ limit })).rejects.toBeInstanceOf(
        InvalidResumeListRequestError,
      );
      expect(listActive).not.toHaveBeenCalled();
    },
  );
});
