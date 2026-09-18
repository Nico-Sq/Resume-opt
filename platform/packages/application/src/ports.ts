import type { ResumeDocumentV1 } from '@resume/domain/resume';

export interface CurrentIdentity {
  userId: string;
}

export interface IdentityProvider {
  requireIdentity(): Promise<CurrentIdentity>;
}

export interface PersistedResume {
  id: string;
  userId: string;
  title: string;
  document: unknown;
  revision: bigint;
  schemaVersion: number;
  templateId: string;
  templateVersion: string;
  updatedAt: Date;
}

export interface ResumeReader {
  findActiveById(resumeId: string): Promise<PersistedResume | null>;
}

export interface SaveResumeCommand {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  clientSeq: number;
  document: ResumeDocumentV1;
  traceId: string;
}

export interface SaveReceipt {
  resumeId: string;
  revision: string;
  versionId: string;
  acknowledgedSeq: number;
  savedAt: string;
  contentHash: string;
}

export interface SaveResumeResult {
  receipt: SaveReceipt;
  replayed: boolean;
}

export interface ResumeWriter {
  saveDocument(command: SaveResumeCommand): Promise<SaveResumeResult>;
}

export interface ResumeRepository extends ResumeReader, ResumeWriter {}

export interface UserTransaction {
  resumes: ResumeRepository;
}

export interface UserTransactionManager {
  withUser<T>(userId: string, work: (transaction: UserTransaction) => Promise<T>): Promise<T>;
}
