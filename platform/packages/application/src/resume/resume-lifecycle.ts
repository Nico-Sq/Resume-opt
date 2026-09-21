import { z } from 'zod';

import type {
  DeleteResumeReceipt,
  DeletedResumeMetadataRecord,
  IdentityProvider,
  RenameResumeReceipt,
  UserTransactionManager,
} from '../ports';

const RevisionSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'revision 超出范围');
const LifecycleInputSchema = z.strictObject({
  resumeId: z.uuid(),
  idempotencyKey: z.uuid(),
  baseRevision: RevisionSchema,
  traceId: z.uuid(),
});
const DeleteInputSchema = LifecycleInputSchema.extend({ confirm: z.literal(true) });
const ListInputSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});
const CursorSchema = z.strictObject({
  version: z.literal(1),
  list: z.literal('deleted-resumes'),
  userId: z.uuid(),
  deletedAt: z.iso.datetime(),
  id: z.uuid(),
});

export class InvalidResumeLifecycleRequestError extends Error {
  readonly code = 'INVALID_SCHEMA';

  constructor() {
    super('简历删除或恢复请求无效');
    this.name = 'InvalidResumeLifecycleRequestError';
  }
}

export class RestoreWindowExpiredError extends Error {
  readonly code = 'RESTORE_WINDOW_EXPIRED';

  constructor() {
    super('简历恢复期限已过');
    this.name = 'RestoreWindowExpiredError';
  }
}

export class InvalidDeletedResumeListRequestError extends Error {
  readonly code = 'INVALID_QUERY';

  constructor() {
    super('回收站分页参数无效');
    this.name = 'InvalidDeletedResumeListRequestError';
  }
}

export class InvalidDeletedResumeCursorError extends Error {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('回收站分页游标无效');
    this.name = 'InvalidDeletedResumeCursorError';
  }
}

export interface DeleteResumeInput {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  traceId: string;
  confirm: true;
}

export interface UndeleteResumeInput {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  traceId: string;
}

export interface DeletedResumeMetaDto {
  id: string;
  title: string;
  locale: string;
  stage: DeletedResumeMetadataRecord['stage'];
  revision: string;
  templateId: string;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string;
  restoreUntil: string;
}

export class DeleteResume {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: DeleteResumeInput): Promise<DeleteResumeReceipt & { replayed: boolean }> {
    const parsed = DeleteInputSchema.safeParse(input);
    if (!parsed.success) throw new InvalidResumeLifecycleRequestError();
    const identity = await this.identityProvider.requireIdentity();
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const command = {
        resumeId: parsed.data.resumeId,
        idempotencyKey: parsed.data.idempotencyKey,
        baseRevision: parsed.data.baseRevision,
        traceId: parsed.data.traceId,
      };
      const result = await transaction.resumes.delete(command);
      return { ...result.receipt, replayed: result.replayed };
    });
  }
}

export class UndeleteResume {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: UndeleteResumeInput): Promise<RenameResumeReceipt & { replayed: boolean }> {
    const parsed = LifecycleInputSchema.safeParse(input);
    if (!parsed.success) throw new InvalidResumeLifecycleRequestError();
    const identity = await this.identityProvider.requireIdentity();
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const result = await transaction.resumes.undelete(parsed.data);
      return { ...result.receipt, replayed: result.replayed };
    });
  }
}

function decodeCursor(cursor: string, userId: string) {
  try {
    const parsed = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.userId !== userId) throw new InvalidDeletedResumeCursorError();
    return { deletedAt: new Date(parsed.deletedAt), id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidDeletedResumeCursorError) throw error;
    throw new InvalidDeletedResumeCursorError();
  }
}

function toDto(record: DeletedResumeMetadataRecord): DeletedResumeMetaDto {
  return {
    id: record.id,
    title: record.title,
    locale: record.locale,
    stage: record.stage,
    revision: record.revision.toString(),
    templateId: record.templateId,
    templateVersion: record.templateVersion,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    deletedAt: record.deletedAt.toISOString(),
    restoreUntil: record.restoreUntil.toISOString(),
  };
}

export class ListDeletedResumes {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: { cursor?: string; limit?: number } = {}) {
    const parsed = ListInputSchema.safeParse(input);
    if (!parsed.success) throw new InvalidDeletedResumeListRequestError();
    const identity = await this.identityProvider.requireIdentity();
    const after = parsed.data.cursor
      ? decodeCursor(parsed.data.cursor, identity.userId)
      : undefined;
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const records = await transaction.resumes.listDeleted({
        limit: parsed.data.limit + 1,
        ...(after ? { after } : {}),
      });
      const page = records.slice(0, parsed.data.limit);
      const last = page.at(-1);
      return {
        items: page.map(toDto),
        nextCursor:
          records.length > parsed.data.limit && last
            ? Buffer.from(
                JSON.stringify({
                  version: 1,
                  list: 'deleted-resumes',
                  userId: identity.userId,
                  deletedAt: last.deletedAt.toISOString(),
                  id: last.id,
                }),
              ).toString('base64url')
            : null,
      };
    });
  }
}
