export {
  applyResumeEditCommand,
  ResumeEditError,
  type EditablePrimitive,
  type ResumeEditCommand,
  type ResumeEditErrorCode,
  type StringListField,
  type TextBlockListField,
} from './commands';
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
