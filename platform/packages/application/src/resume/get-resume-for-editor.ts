import { migrateResumeDocument, type ResumeDocumentV1 } from '@resume/domain/resume';

import type { IdentityProvider, UserTransactionManager } from '../ports';

export class ResourceNotFoundError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';

  constructor() {
    super('资源不存在');
    this.name = 'ResourceNotFoundError';
  }
}

export class StoredResumeInvalidError extends Error {
  readonly code = 'STORED_RESUME_INVALID';

  constructor(options?: ErrorOptions) {
    super('已保存的简历结构无效', options);
    this.name = 'StoredResumeInvalidError';
  }
}

export interface ResumeEditorDto {
  id: string;
  title: string;
  document: ResumeDocumentV1;
  revision: string;
  schemaVersion: 1;
  templateId: string;
  templateVersion: string;
  updatedAt: string;
}

export class GetResumeForEditor {
  constructor(
    private readonly identityProvider: IdentityProvider,
    private readonly transactions: UserTransactionManager,
  ) {}

  async execute(resumeId: string): Promise<ResumeEditorDto> {
    const identity = await this.identityProvider.requireIdentity();
    return this.transactions.withUser(identity.userId, async (transaction) => {
      const persisted = await transaction.resumes.findActiveById(resumeId);
      if (!persisted) throw new ResourceNotFoundError();

      let document: ResumeDocumentV1;
      try {
        document = migrateResumeDocument(persisted.document);
      } catch (cause) {
        throw new StoredResumeInvalidError({ cause });
      }

      return {
        id: persisted.id,
        title: persisted.title,
        document,
        revision: persisted.revision.toString(),
        schemaVersion: 1,
        templateId: persisted.templateId,
        templateVersion: persisted.templateVersion,
        updatedAt: persisted.updatedAt.toISOString(),
      };
    });
  }
}
