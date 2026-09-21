import { z } from 'zod';

import type { IdentityProvider, ResumeMetadataRecord, UserTransactionManager } from '../ports';

const CursorSchema = z.strictObject({
  version: z.literal(1),
  list: z.literal('active-resumes'),
  userId: z.uuid(),
  updatedAt: z.iso.datetime(),
  id: z.uuid(),
});
const InputSchema = z.strictObject({
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(20),
});

export interface ResumeMetaDto {
  id: string;
  title: string;
  locale: string;
  stage: ResumeMetadataRecord['stage'];
  revision: string;
  templateId: string;
  templateVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResumePageDto {
  items: ResumeMetaDto[];
  nextCursor: string | null;
}

export class InvalidResumeListRequestError extends Error {
  readonly code = 'INVALID_QUERY';

  constructor() {
    super('分页参数无效');
    this.name = 'InvalidResumeListRequestError';
  }
}

export class InvalidResumeCursorError extends Error {
  readonly code = 'INVALID_CURSOR';

  constructor() {
    super('分页游标无效');
    this.name = 'InvalidResumeCursorError';
  }
}

function decodeCursor(cursor: string, userId: string) {
  try {
    const parsed = CursorSchema.parse(
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')),
    );
    if (parsed.userId !== userId) throw new InvalidResumeCursorError();
    return { updatedAt: new Date(parsed.updatedAt), id: parsed.id };
  } catch (error) {
    if (error instanceof InvalidResumeCursorError) throw error;
    throw new InvalidResumeCursorError();
  }
}

function encodeCursor(record: ResumeMetadataRecord, userId: string) {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      list: 'active-resumes',
      userId,
      updatedAt: record.updatedAt.toISOString(),
      id: record.id,
    }),
  ).toString('base64url');
}

function toDto(record: ResumeMetadataRecord): ResumeMetaDto {
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
  };
}

export class ListResumes {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(input: { cursor?: string; limit?: number } = {}): Promise<ResumePageDto> {
    const parsed = InputSchema.safeParse(input);
    if (!parsed.success) throw new InvalidResumeListRequestError();
    const identity = await this.identityProvider.requireIdentity();
    const after = parsed.data.cursor
      ? decodeCursor(parsed.data.cursor, identity.userId)
      : undefined;
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const records = await transaction.resumes.listActive({
        limit: parsed.data.limit + 1,
        ...(after ? { after } : {}),
      });
      const page = records.slice(0, parsed.data.limit);
      const last = page.at(-1);
      return {
        items: page.map(toDto),
        nextCursor:
          records.length > parsed.data.limit && last ? encodeCursor(last, identity.userId) : null,
      };
    });
  }
}
