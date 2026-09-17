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

export interface UserTransaction {
  resumes: ResumeReader;
}

export interface UserTransactionManager {
  withUser<T>(userId: string, work: (transaction: UserTransaction) => Promise<T>): Promise<T>;
}
