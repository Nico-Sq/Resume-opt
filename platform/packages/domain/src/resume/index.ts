export { createInitialResumeDocument, type IdFactory } from './default';
export { migrateResumeDocument, SchemaVersionUnsupportedError } from './migration';
export {
  ContactSchema,
  ContentSectionSchema,
  LinkSchema,
  PeriodSchema,
  ResumeDocumentV1Schema,
  ResumeDocumentV1ShapeSchema,
  TextBlockSchema,
  type ContentSection,
  type ResumeDocumentV1,
} from './schema';
