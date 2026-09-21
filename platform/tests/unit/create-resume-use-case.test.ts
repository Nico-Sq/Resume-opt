import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  CreateResume,
  InvalidCreateResumeRequestError,
  type CreateResumeCommand,
  type CreateResumeResult,
  type UserTransactionManager,
} from '@resume/application';

const userId = '51000000-0000-4000-8000-000000000001';

function harness() {
  const create = vi.fn<(command: CreateResumeCommand) => Promise<CreateResumeResult>>((command) =>
    Promise.resolve({
      resume: {
        id: command.resumeId,
        userId,
        title: command.title,
        document: command.document,
        revision: 1n,
        schemaVersion: 1,
        templateId: command.document.templateId,
        templateVersion: command.document.templateVersion,
        updatedAt: new Date('2026-09-21T00:00:00.000Z'),
      },
      receipt: { resumeId: command.resumeId, revision: '1', versionId: randomUUID() },
      replayed: false,
    }),
  );
  const transactions: UserTransactionManager = {
    withUser(currentUserId, work) {
      expect(currentUserId).toBe(userId);
      return work({
        resumes: {
          copy: () => Promise.reject(new Error('本测试不调用复制')),
          create,
          findActiveById: () => Promise.resolve(null),
          listActive: () => Promise.resolve([]),
          rename: () => Promise.reject(new Error('本测试不调用重命名')),
          saveDocument: () => Promise.reject(new Error('本测试不调用保存')),
        },
      });
    },
  };
  return {
    create,
    useCase: new CreateResume({ requireIdentity: () => Promise.resolve({ userId }) }, transactions),
  };
}

describe('CreateResume', () => {
  it.each([
    ['blank', 'student'],
    ['basic-template', 'employed'],
  ] as const)(
    'creates one empty %s document owned by the authenticated user',
    async (mode, stage) => {
      const { create, useCase } = harness();
      const result = await useCase.execute({
        idempotencyKey: randomUUID(),
        title: '  我的简历  ',
        stage,
        mode,
        traceId: randomUUID(),
      });
      const command = create.mock.calls[0]?.[0];
      if (!command) throw new Error('未观察到创建命令');

      expect(command).toMatchObject({ title: '我的简历', stage, mode });
      expect(command.resumeId).toMatch(/^[0-9a-f-]{36}$/u);
      expect(command.document).toMatchObject({
        stage,
        templateId: 'ats-basic',
        templateVersion: '1.0.0',
      });
      expect(JSON.stringify(command.document)).not.toMatch(/张三|示例大学|示例公司/u);
      expect(result.resume).toMatchObject({
        id: command.resumeId,
        title: '我的简历',
        revision: '1',
        document: command.document,
      });
    },
  );

  it('validates trimmed Unicode title length and rejects extra ownership fields before a transaction', async () => {
    const { create, useCase } = harness();
    await expect(
      useCase.execute({
        idempotencyKey: randomUUID(),
        title: '😀'.repeat(200),
        stage: 'transition',
        mode: 'blank',
        traceId: randomUUID(),
      }),
    ).resolves.toMatchObject({ resume: { title: '😀'.repeat(200) } });
    await expect(
      useCase.execute({
        idempotencyKey: randomUUID(),
        title: '😀'.repeat(201),
        stage: 'transition',
        mode: 'blank',
        traceId: randomUUID(),
      }),
    ).rejects.toBeInstanceOf(InvalidCreateResumeRequestError);
    await expect(
      useCase.execute({
        idempotencyKey: randomUUID(),
        title: '越权字段',
        stage: 'student',
        mode: 'blank',
        traceId: randomUUID(),
        ownerId: randomUUID(),
      } as Parameters<CreateResume['execute']>[0]),
    ).rejects.toBeInstanceOf(InvalidCreateResumeRequestError);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
