import { ResumeDocumentV1Schema, type ResumeDocumentV1 } from './schema';

export class SchemaVersionUnsupportedError extends Error {
  readonly code = 'SCHEMA_VERSION_UNSUPPORTED';

  constructor(version: unknown) {
    super(`不支持的简历结构版本：${String(version)}`);
    this.name = 'SchemaVersionUnsupportedError';
  }
}

export function migrateResumeDocument(input: unknown): ResumeDocumentV1 {
  if (typeof input !== 'object' || input === null || !('schemaVersion' in input)) {
    throw new SchemaVersionUnsupportedError(undefined);
  }

  if (input.schemaVersion === 1) return ResumeDocumentV1Schema.parse(input);
  throw new SchemaVersionUnsupportedError(input.schemaVersion);
}
