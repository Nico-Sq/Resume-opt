import { z } from 'zod';

import type { IdentityProvider, UserTransactionManager } from '../ports';
import { ResumeTitleSchema } from './create-resume';
import { toResumeEditorDto, type ResumeEditorDto } from './get-resume-for-editor';

const CopyResumeInputSchema = z.strictObject({
  sourceResumeId: z.uuid(),
  idempotencyKey: z.uuid(),
  sourceRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'revision 超出范围'),
  title: ResumeTitleSchema,
  traceId: z.uuid(),
});

export interface CopyResumeInput {
  sourceResumeId: string;
  idempotencyKey: string;
  sourceRevision: string;
  title: string;
  traceId: string;
}

export interface CopyResumeOutput {
  resume: ResumeEditorDto;
  versionId: string;
  replayed: boolean;
}

export class InvalidCopyResumeRequestError extends Error {
  readonly code = 'INVALID_SCHEMA';

  constructor(readonly fieldErrors: Array<{ path: string; code: string; message: string }>) {
    super('复制简历请求无效');
    this.name = 'InvalidCopyResumeRequestError';
  }
}

export class CopyResume {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: CopyResumeInput): Promise<CopyResumeOutput> {
    const parsed = CopyResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidCopyResumeRequestError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    const identity = await this.identityProvider.requireIdentity();
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const result = await transaction.resumes.copy({
        ...parsed.data,
        targetResumeId: crypto.randomUUID(),
      });
      return {
        resume: toResumeEditorDto(result.resume),
        versionId: result.receipt.versionId,
        replayed: result.replayed,
      };
    });
  }
}
