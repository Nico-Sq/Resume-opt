import { createInitialResumeDocument, type ResumeStage } from '@resume/domain/resume';
import { z } from 'zod';

import type { CreateResumeMode, IdentityProvider, UserTransactionManager } from '../ports';
import { toResumeEditorDto, type ResumeEditorDto } from './get-resume-for-editor';

export const ResumeTitleSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => Array.from(value).length >= 1 && Array.from(value).length <= 200, {
    message: '简历名称须为 1—200 个 Unicode 字符',
  });
const CreateResumeInputSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  title: ResumeTitleSchema,
  stage: z.enum(['student', 'employed', 'transition']),
  mode: z.enum(['blank', 'basic-template']),
  traceId: z.uuid(),
});

export interface CreateResumeInput {
  idempotencyKey: string;
  title: string;
  stage: ResumeStage;
  mode: CreateResumeMode;
  traceId: string;
}

export interface CreateResumeOutput {
  resume: ResumeEditorDto;
  versionId: string;
  replayed: boolean;
}

export class InvalidCreateResumeRequestError extends Error {
  readonly code = 'INVALID_SCHEMA';

  constructor(readonly fieldErrors: Array<{ path: string; code: string; message: string }>) {
    super('新建简历请求无效');
    this.name = 'InvalidCreateResumeRequestError';
  }
}

export class CreateResume {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: CreateResumeInput): Promise<CreateResumeOutput> {
    const parsed = CreateResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidCreateResumeRequestError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    const identity = await this.identityProvider.requireIdentity();
    const document = createInitialResumeDocument(undefined, parsed.data.stage);
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const result = await transaction.resumes.create({
        ...parsed.data,
        resumeId: crypto.randomUUID(),
        document,
      });
      return {
        resume: toResumeEditorDto(result.resume),
        versionId: result.receipt.versionId,
        replayed: result.replayed,
      };
    });
  }
}
