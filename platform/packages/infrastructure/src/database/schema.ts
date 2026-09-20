import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey(),
    status: text('status').notNull(),
    displayName: text('display_name').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [check('users_status_check', sql`${table.status} in ('active', 'disabled')`)],
);

export const authUsers = pgTable(
  'auth_users',
  {
    id: uuid('id')
      .primaryKey()
      .defaultRandom()
      .references(() => users.id),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    image: text('image'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [unique('auth_users_email_unique').on(table.email)],
);

export const authSessions = pgTable(
  'auth_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    expiresAt: timestamp('expires_at').notNull(),
    token: text('token').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
  },
  (table) => [
    unique('auth_sessions_token_unique').on(table.token),
    index('auth_sessions_userId_idx').on(table.userId),
  ],
);

export const authAccounts = pgTable(
  'auth_accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => [index('auth_accounts_userId_idx').on(table.userId)],
);

export const authVerifications = pgTable(
  'auth_verifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: timestamp('expires_at').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [index('auth_verifications_identifier_idx').on(table.identifier)],
);

export const authRateLimits = pgTable(
  'auth_rate_limits',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    key: text('key').notNull(),
    count: integer('count').notNull(),
    lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
  },
  (table) => [
    unique('auth_rate_limits_key_unique').on(table.key),
    check('auth_rate_limits_count_check', sql`${table.count} >= 1`),
  ],
);

export const templates = pgTable(
  'templates',
  {
    templateId: text('template_id').notNull(),
    version: text('version').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    manifest: jsonb('manifest').notNull(),
    assetHash: text('asset_hash').notNull(),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.version] }),
    check('templates_status_check', sql`${table.status} in ('draft', 'published', 'retired')`),
  ],
);

export const resumes = pgTable(
  'resumes',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    document: jsonb('document').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull().default(0n),
    schemaVersion: bigint('schema_version', { mode: 'number' }).notNull(),
    templateId: text('template_id').notNull(),
    templateVersion: text('template_version').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (table) => [
    unique('resumes_id_user_unique').on(table.id, table.userId),
    foreignKey({
      columns: [table.templateId, table.templateVersion],
      foreignColumns: [templates.templateId, templates.version],
      name: 'resumes_template_fk',
    }),
    index('resumes_user_updated_idx')
      .on(table.userId, table.updatedAt)
      .where(sql`${table.deletedAt} is null`),
    check('resumes_revision_check', sql`${table.revision} >= 0`),
    check('resumes_schema_version_check', sql`${table.schemaVersion} = 1`),
  ],
);

export const resumeVersions = pgTable(
  'resume_versions',
  {
    id: uuid('id').primaryKey(),
    resumeId: uuid('resume_id').notNull(),
    userId: uuid('user_id').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
    titleSnapshot: text('title_snapshot').notNull(),
    schemaVersion: bigint('schema_version', { mode: 'number' }).notNull(),
    templateId: text('template_id').notNull(),
    templateVersion: text('template_version').notNull(),
    rendererVersion: text('renderer_version').notNull(),
    snapshot: jsonb('snapshot').notNull(),
    contentHash: text('content_hash').notNull(),
    reason: text('reason').notNull(),
    sourceVersionId: uuid('source_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('resume_versions_resume_revision_unique').on(table.resumeId, table.revision),
    foreignKey({
      columns: [table.resumeId, table.userId],
      foreignColumns: [resumes.id, resumes.userId],
      name: 'resume_versions_owner_fk',
    }).onDelete('cascade'),
    foreignKey({
      columns: [table.templateId, table.templateVersion],
      foreignColumns: [templates.templateId, templates.version],
      name: 'resume_versions_template_fk',
    }),
    foreignKey({
      columns: [table.sourceVersionId],
      foreignColumns: [table.id],
      name: 'resume_versions_source_fk',
    }),
    index('resume_versions_resume_revision_idx').on(table.resumeId, table.revision),
    check('resume_versions_revision_check', sql`${table.revision} >= 1`),
    check(
      'resume_versions_reason_check',
      sql`${table.reason} in ('autosave', 'edit', 'restore', 'initial')`,
    ),
  ],
);

export const idempotencyRequests = pgTable(
  'idempotency_requests',
  {
    userId: uuid('user_id').notNull(),
    operation: text('operation').notNull(),
    key: uuid('key').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').notNull(),
    responseBody: jsonb('response_body'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.operation, table.key] }),
    check('idempotency_status_check', sql`${table.status} in ('processing', 'completed')`),
  ],
);

export const auditEvents = pgTable('audit_events', {
  id: uuid('id').primaryKey(),
  actorUserId: uuid('actor_user_id').notNull(),
  action: text('action').notNull(),
  resourceType: text('resource_type').notNull(),
  resourceId: uuid('resource_id').notNull(),
  traceId: uuid('trace_id').notNull(),
  resultCode: text('result_code').notNull(),
  metadata: jsonb('metadata').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
