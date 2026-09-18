import { ResumeDocumentV1Schema } from '@resume/domain/resume';
import { z } from 'zod';

const RevisionSchema = z
  .string()
  .regex(/^[1-9][0-9]*$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, 'revision 超出范围');
const SequenceSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const PendingSaveEnvelopeSchema = z.strictObject({
  idempotencyKey: z.uuid(),
  resumeId: z.uuid(),
  baseRevision: RevisionSchema,
  clientSeq: SequenceSchema,
  document: ResumeDocumentV1Schema,
  createdAt: z.iso.datetime({ offset: true }),
});

export const LocalDraftScopeSchema = z.strictObject({
  userId: z.uuid(),
  resumeId: z.uuid(),
  tabId: z.uuid(),
});

export const LocalDraftRecordSchema = z
  .strictObject({
    formatVersion: z.literal(1),
    userId: z.uuid(),
    resumeId: z.uuid(),
    tabId: z.uuid(),
    baseRevision: RevisionSchema,
    baseSnapshot: ResumeDocumentV1Schema,
    workingSnapshot: ResumeDocumentV1Schema,
    localSeq: SequenceSchema,
    ackedSeq: SequenceSchema,
    pendingEnvelope: PendingSaveEnvelopeSchema.nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .superRefine((record, context) => {
    if (record.ackedSeq > record.localSeq) {
      context.addIssue({
        code: 'custom',
        path: ['ackedSeq'],
        message: 'ackedSeq 不能超过 localSeq',
      });
    }
    const pending = record.pendingEnvelope;
    if (!pending) return;
    if (pending.resumeId !== record.resumeId) {
      context.addIssue({
        code: 'custom',
        path: ['pendingEnvelope', 'resumeId'],
        message: '待确认信封必须属于当前简历',
      });
    }
    if (pending.baseRevision !== record.baseRevision) {
      context.addIssue({
        code: 'custom',
        path: ['pendingEnvelope', 'baseRevision'],
        message: '待确认信封必须基于当前远端基线',
      });
    }
    if (pending.clientSeq <= record.ackedSeq || pending.clientSeq > record.localSeq) {
      context.addIssue({
        code: 'custom',
        path: ['pendingEnvelope', 'clientSeq'],
        message: '待确认信封序号必须位于已确认和本地序号之间',
      });
    }
  });

export interface LocalDraftScope {
  userId: string;
  resumeId: string;
  tabId: string;
}

export type PendingSaveEnvelope = z.infer<typeof PendingSaveEnvelopeSchema>;
export type LocalDraftRecord = z.infer<typeof LocalDraftRecordSchema>;

export interface LocalDraftRescueExport {
  format: 'resume-opt-local-draft-rescue';
  formatVersion: 1;
  userId: string;
  exportedAt: string;
  drafts: LocalDraftRecord[];
}

export function parseLocalDraftScope(scope: LocalDraftScope): LocalDraftScope {
  return LocalDraftScopeSchema.parse(scope);
}

export function parseLocalDraftRecord(record: LocalDraftRecord): LocalDraftRecord {
  return LocalDraftRecordSchema.parse(record);
}

export function hasUnsyncedLocalChanges(record: LocalDraftRecord): boolean {
  return record.localSeq > record.ackedSeq || record.pendingEnvelope !== null;
}
