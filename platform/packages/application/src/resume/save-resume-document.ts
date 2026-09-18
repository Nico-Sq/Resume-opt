import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from '@resume/domain/resume';
import { z } from 'zod';

import type {
  IdentityProvider,
  SaveReceipt,
  SaveResumeResult,
  UserTransactionManager,
} from '../ports';
import { ResourceNotFoundError } from './get-resume-for-editor';

const SaveResumeInputSchema = z.strictObject({
  resumeId: z.uuid(),
  idempotencyKey: z.uuid(),
  baseRevision: z
    .string()
    .regex(/^[1-9][0-9]*$/u)
    .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'revision 超出范围'),
  clientSeq: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  document: ResumeDocumentV1Schema,
  traceId: z.uuid(),
});

export interface SaveResumeDocumentInput {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  clientSeq: number;
  document: ResumeDocumentV1;
  traceId: string;
}

export interface SaveResumeDocumentResult {
  receipt: SaveReceipt;
  replayed: boolean;
}

export interface SaveFieldError {
  path: string;
  code: string;
  message: string;
}

export class InvalidSaveRequestError extends Error {
  readonly code = 'INVALID_SCHEMA';

  constructor(readonly fieldErrors: SaveFieldError[]) {
    super('保存内容不符合简历结构要求');
    this.name = 'InvalidSaveRequestError';
  }
}

export class RevisionConflictError extends Error {
  readonly code = 'REVISION_CONFLICT';

  constructor(readonly currentRevision: string) {
    super('简历已在其他位置更新，请保留本地内容并比较版本。');
    this.name = 'RevisionConflictError';
  }
}

export class IdempotencyKeyReusedError extends Error {
  readonly code = 'IDEMPOTENCY_KEY_REUSED';

  constructor() {
    super('幂等键已用于不同的保存请求');
    this.name = 'IdempotencyKeyReusedError';
  }
}

export class IdempotencyRequestInProgressError extends Error {
  readonly code = 'IDEMPOTENCY_REQUEST_IN_PROGRESS';

  constructor() {
    super('相同保存请求仍在处理中');
    this.name = 'IdempotencyRequestInProgressError';
  }
}

export class TemplateUnavailableError extends Error {
  readonly code = 'TEMPLATE_UNAVAILABLE';

  constructor() {
    super('当前模板版本不可用于保存');
    this.name = 'TemplateUnavailableError';
  }
}

export class SaveResumeDocument {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: SaveResumeDocumentInput): Promise<SaveResumeDocumentResult> {
    const parsed = SaveResumeInputSchema.safeParse(input);
    if (!parsed.success) {
      throw new InvalidSaveRequestError(
        parsed.error.issues.map((issue) => ({
          path: issue.path.join('.'),
          code: issue.code,
          message: issue.message,
        })),
      );
    }

    const identity = await this.identityProvider.requireIdentity();
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const result: SaveResumeResult = await transaction.resumes.saveDocument(parsed.data);
      return result;
    });
  }
}

export { ResourceNotFoundError };
