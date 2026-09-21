import type { ResumeDocumentV1 } from '@resume/domain/resume';

export interface CurrentIdentity {
  userId: string;
}

export class AuthenticationRequiredError extends Error {
  readonly code = 'AUTHENTICATION_REQUIRED';

  constructor() {
    super('需要登录');
    this.name = 'AuthenticationRequiredError';
  }
}

export interface IdentityProvider {
  requireIdentity(): Promise<CurrentIdentity>;
}

export interface AuthenticatedSession {
  userId: string;
  displayName: string;
  emailVerified: boolean;
  expiresAt: string;
}

export interface SessionProvider {
  getSession(): Promise<AuthenticatedSession | null>;
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

export interface ResumeMetadataRecord {
  id: string;
  title: string;
  locale: string;
  stage: ResumeDocumentV1['stage'];
  revision: bigint;
  templateId: string;
  templateVersion: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ResumeListQuery {
  limit: number;
  after?: { updatedAt: Date; id: string };
}

export interface ResumeListReader {
  listActive(query: ResumeListQuery): Promise<ResumeMetadataRecord[]>;
}

export interface SaveResumeCommand {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  clientSeq: number;
  document: ResumeDocumentV1;
  traceId: string;
}

export type CreateResumeMode = 'blank' | 'basic-template';

export interface CreateResumeCommand {
  resumeId: string;
  idempotencyKey: string;
  title: string;
  stage: ResumeDocumentV1['stage'];
  mode: CreateResumeMode;
  document: ResumeDocumentV1;
  traceId: string;
}

export interface CreateResumeReceipt {
  resumeId: string;
  revision: string;
  versionId: string;
}

export interface CreateResumeResult {
  resume: PersistedResume;
  receipt: CreateResumeReceipt;
  replayed: boolean;
}

export interface CopyResumeCommand {
  sourceResumeId: string;
  targetResumeId: string;
  idempotencyKey: string;
  sourceRevision: string;
  title: string;
  traceId: string;
}

export interface CopyResumeResult {
  resume: PersistedResume;
  receipt: CreateResumeReceipt;
  replayed: boolean;
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

export interface RenameResumeCommand {
  resumeId: string;
  idempotencyKey: string;
  baseRevision: string;
  title: string;
  traceId: string;
}

export interface RenameResumeReceipt {
  resume: {
    id: string;
    title: string;
    locale: string;
    stage: ResumeDocumentV1['stage'];
    revision: string;
    templateId: string;
    templateVersion: string;
    createdAt: string;
    updatedAt: string;
  };
  versionId: string;
}

export interface RenameResumeResult {
  receipt: RenameResumeReceipt;
  replayed: boolean;
}

export interface ResumeWriter {
  copy(command: CopyResumeCommand): Promise<CopyResumeResult>;
  create(command: CreateResumeCommand): Promise<CreateResumeResult>;
  rename(command: RenameResumeCommand): Promise<RenameResumeResult>;
  saveDocument(command: SaveResumeCommand): Promise<SaveResumeResult>;
}

export interface ResumeRepository extends ResumeReader, ResumeWriter, ResumeListReader {}

export interface UserTransaction {
  resumes: ResumeRepository;
}

export interface UserTransactionManager {
  withUser<T>(userId: string, work: (transaction: UserTransaction) => Promise<T>): Promise<T>;
}
