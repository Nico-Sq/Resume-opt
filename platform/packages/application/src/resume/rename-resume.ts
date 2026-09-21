import { z } from 'zod';

import type { IdentityProvider, RenameResumeReceipt, UserTransactionManager } from '../ports';
import { ResumeTitleSchema } from './create-resume';

const RenameResumeInputSchema = z.strictObject({
  resumeId: z.uuid(),
  idempotencyKey: z.uuid(),
  baseRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'revision 超出范围'),
  title: ResumeTitleSchema,
  traceId: z.uuid(),
});

export interface RenameResumeInput {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  title: string;
  traceId: string;
}

export interface RenameResumeOutput extends RenameResumeReceipt {
  replayed: boolean;
}

export class InvalidRenameResumeRequestError extends Error {
  readonly code = 'INVALID_SCHEMA';

  constructor(readonly fieldErrors: Array<{ path: string; code: string; message: string }>) {
    super('重命名请求无效');
    this.name = 'InvalidRenameResumeRequestError';
  }
}

export class RenameResume {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: RenameResumeInput): Promise<RenameResumeOutput> {
    const parsed = RenameResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidRenameResumeRequestError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      );
    }
    const identity = await this.identityProvider.requireIdentity();
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const result = await transaction.resumes.rename(parsed.data);
      return { ...result.receipt, replayed: result.replayed };
    });
  }
}
