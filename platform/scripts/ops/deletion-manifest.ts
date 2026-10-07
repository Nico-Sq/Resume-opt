import { createHash } from 'node:crypto';

import type { createPostgresPool } from '@resume/infrastructure/postgres';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const positiveIntegerPattern = /^[1-9][0-9]*$/u;
const nonNegativeIntegerPattern = /^(?:0|[1-9][0-9]*)$/u;

export type DeletionManifestEventType =
  'soft_delete' | 'restore' | 'hard_delete' | 'account_delete';

export interface DeletionManifestEvent {
  sequence: string;
  id: string;
  resourceType: 'resume' | 'account';
  resourceId: string;
  userId: string;
  eventType: DeletionManifestEventType;
  revision: string;
  occurredAt: string;
  restoreUntil: string | null;
  policyVersion: number;
  traceId: string;
}

export interface DeletionManifest {
  schemaVersion: number;
  manifestId: string;
  generatedAt: string;
  firstSequence: string;
  throughSequence: string;
  eventCount: number;
  events: DeletionManifestEvent[];
  payloadSha256: string;
}

interface ManifestPayload {
  schemaVersion: number;
  manifestId: string;
  generatedAt: string;
  firstSequence: string;
  throughSequence: string;
  eventCount: number;
  events: DeletionManifestEvent[];
}

function isIsoTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function manifestPayload(manifest: Omit<DeletionManifest, 'payloadSha256'>): ManifestPayload {
  return {
    schemaVersion: manifest.schemaVersion,
    manifestId: manifest.manifestId,
    generatedAt: manifest.generatedAt,
    firstSequence: manifest.firstSequence,
    throughSequence: manifest.throughSequence,
    eventCount: manifest.eventCount,
    events: manifest.events,
  };
}

function payloadHash(payload: ManifestPayload): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function validateEvents(events: readonly DeletionManifestEvent[]): void {
  const eventIds = new Set<string>();
  const latestByResource = new Map<
    string,
    { revisions: Set<bigint>; terminalRevision?: bigint; userId: string }
  >();
  let previousSequence = 0n;

  for (const event of events) {
    if (!positiveIntegerPattern.test(event.sequence)) throw new Error('删除清单事件序号无效');
    const sequence = BigInt(event.sequence);
    if (sequence <= previousSequence) throw new Error('删除清单事件序号必须严格递增');
    previousSequence = sequence;

    if (!uuidPattern.test(event.id) || eventIds.has(event.id)) {
      throw new Error('删除清单事件 ID 无效或重复');
    }
    eventIds.add(event.id);
    if (
      !uuidPattern.test(event.resourceId) ||
      !uuidPattern.test(event.userId) ||
      !uuidPattern.test(event.traceId)
    ) {
      throw new Error('删除清单资源标识无效');
    }
    if (!positiveIntegerPattern.test(event.revision)) throw new Error('删除清单资源版本无效');
    if (!isIsoTimestamp(event.occurredAt)) throw new Error('删除清单事件时间无效');
    if (event.restoreUntil !== null && !isIsoTimestamp(event.restoreUntil)) {
      throw new Error('删除清单恢复期限无效');
    }
    if (event.policyVersion !== 1) throw new Error('删除清单策略版本不受支持');
    if (
      (event.resourceType === 'account' && event.eventType !== 'account_delete') ||
      (event.resourceType === 'resume' && event.eventType === 'account_delete')
    ) {
      throw new Error('删除清单资源类型与事件类型不匹配');
    }
    if (event.resourceType === 'account' && event.resourceId !== event.userId) {
      throw new Error('账户注销事件的资源与账户标识必须一致');
    }
    if (
      (event.eventType === 'soft_delete' && event.restoreUntil === null) ||
      (event.eventType !== 'soft_delete' && event.restoreUntil !== null)
    ) {
      throw new Error('删除清单恢复期限与事件类型不匹配');
    }

    const resourceKey = `${event.resourceType}:${event.resourceId}`;
    const prior = latestByResource.get(resourceKey);
    const revision = BigInt(event.revision);
    if (prior && prior.userId !== event.userId) throw new Error('同一资源不能跨账户变更');
    if (prior?.revisions.has(revision)) throw new Error('同一资源的事件版本不能重复');
    const terminal = event.eventType === 'hard_delete' || event.eventType === 'account_delete';
    if (terminal && prior?.terminalRevision !== undefined)
      throw new Error('同一资源只能有一个终态');
    const state = prior ?? { revisions: new Set<bigint>(), userId: event.userId };
    state.revisions.add(revision);
    if (terminal) state.terminalRevision = revision;
    latestByResource.set(resourceKey, state);
  }

  for (const state of latestByResource.values()) {
    const terminalRevision = state.terminalRevision;
    if (
      terminalRevision !== undefined &&
      [...state.revisions].some((revision) => revision > terminalRevision)
    ) {
      throw new Error('删除清单终态之后不能再有生命周期事件');
    }
  }
}

type DatabasePool = ReturnType<typeof createPostgresPool>;
const exportSchemaPattern = /^(?:public|[a-z][a-z0-9_]{0,62})$/u;
const replaySchemaPattern =
  /^(?:(?:restore_(?:source|target)|native_restore|manifest_(?:source|target))_[a-f0-9]{32})$/u;

function quoteSchema(schema: string, replay = false): string {
  const pattern = replay ? replaySchemaPattern : exportSchemaPattern;
  if (!pattern.test(schema)) throw new Error('不安全的删除清单数据库 schema');
  return `"${schema}"`;
}

interface ManifestEventRow {
  event_sequence: string;
  event_id: string;
  resource_type: 'resume' | 'account';
  resource_id: string;
  user_id: string;
  event_type: DeletionManifestEventType;
  revision: string;
  occurred_at: Date;
  restore_until: Date | null;
  policy_version: number;
  trace_id: string;
}

export async function readDeletionManifest(
  pool: DatabasePool,
  schema: string,
  metadata: { manifestId: string; generatedAt: string },
): Promise<DeletionManifest> {
  const result = await pool.query<ManifestEventRow>(
    `select * from ${quoteSchema(schema)}.read_deletion_manifest_events()`,
  );
  return createDeletionManifest(
    result.rows.map((row) => ({
      sequence: row.event_sequence,
      id: row.event_id,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      userId: row.user_id,
      eventType: row.event_type,
      revision: row.revision,
      occurredAt: row.occurred_at.toISOString(),
      restoreUntil: row.restore_until?.toISOString() ?? null,
      policyVersion: row.policy_version,
      traceId: row.trace_id,
    })),
    metadata,
  );
}

export async function acknowledgeDeletionManifest(
  pool: DatabasePool,
  schema: string,
  manifest: DeletionManifest,
): Promise<number> {
  const result = await pool.query<{ marked_count: number }>(
    `select ${quoteSchema(schema)}.acknowledge_deletion_manifest($1, $2::uuid[]) as marked_count`,
    [manifest.manifestId, manifest.events.map((event) => event.id)],
  );
  return result.rows[0]?.marked_count ?? 0;
}

export interface DeletionReplayReport {
  manifestId: string;
  throughSequence: string;
  importedEventCount: number;
  sessionsRevoked: number;
  verificationTokensRevoked: number;
  resumesSoftDeleted: number;
  resumesRestored: number;
  resumesHardDeleted: number;
  accountsDeleted: number;
}

function latestEvents(events: readonly DeletionManifestEvent[]): DeletionManifestEvent[] {
  const latest = new Map<string, DeletionManifestEvent>();
  for (const event of events) {
    const key = `${event.resourceType}:${event.resourceId}`;
    const prior = latest.get(key);
    if (!prior || BigInt(event.revision) > BigInt(prior.revision)) latest.set(key, event);
  }
  return [...latest.values()];
}

export async function replayDeletionManifest(
  pool: DatabasePool,
  schema: string,
  manifest: DeletionManifest,
  expected: { expectedThroughSequence: string; expectedPayloadSha256: string },
): Promise<DeletionReplayReport> {
  validateDeletionManifest(manifest, expected);
  const quotedSchema = quoteSchema(schema, true);
  const client = await pool.connect();
  const report: DeletionReplayReport = {
    manifestId: manifest.manifestId,
    throughSequence: manifest.throughSequence,
    importedEventCount: 0,
    sessionsRevoked: 0,
    verificationTokensRevoked: 0,
    resumesSoftDeleted: 0,
    resumesRestored: 0,
    resumesHardDeleted: 0,
    accountsDeleted: 0,
  };

  try {
    await client.query('begin');
    const sessions = await client.query(`delete from ${quotedSchema}.auth_sessions`);
    const verifications = await client.query(`delete from ${quotedSchema}.auth_verifications`);
    report.sessionsRevoked = sessions.rowCount ?? 0;
    report.verificationTokensRevoked = verifications.rowCount ?? 0;

    if (manifest.events.length > 0) {
      const records = manifest.events.map((event) => ({
        event_sequence: event.sequence,
        id: event.id,
        resume_id: event.resourceType === 'resume' ? event.resourceId : null,
        user_id: event.userId,
        event_type: event.eventType,
        revision: event.revision,
        occurred_at: event.occurredAt,
        restore_until: event.restoreUntil,
        policy_version: event.policyVersion,
        trace_id: event.traceId,
      }));
      const imported = await client.query(
        `insert into ${quotedSchema}.deletion_events
           (event_sequence, id, resume_id, user_id, event_type, revision, occurred_at,
            restore_until, policy_version, trace_id, manifest_export_id, manifest_exported_at)
         overriding system value
         select x.event_sequence, x.id, x.resume_id, x.user_id, x.event_type, x.revision,
                x.occurred_at, x.restore_until, x.policy_version, x.trace_id, $2, $3
           from jsonb_to_recordset($1::jsonb) as x(
             event_sequence bigint, id uuid, resume_id uuid, user_id uuid, event_type text,
             revision bigint, occurred_at timestamptz, restore_until timestamptz,
             policy_version integer, trace_id uuid
           )
         on conflict (id) do update
           set manifest_export_id = excluded.manifest_export_id,
               manifest_exported_at = excluded.manifest_exported_at
         where deletion_events.event_sequence = excluded.event_sequence
           and deletion_events.resume_id is not distinct from excluded.resume_id
           and deletion_events.user_id = excluded.user_id
           and deletion_events.event_type = excluded.event_type
           and deletion_events.revision = excluded.revision
           and deletion_events.occurred_at = excluded.occurred_at
           and deletion_events.restore_until is not distinct from excluded.restore_until
           and deletion_events.policy_version = excluded.policy_version
           and deletion_events.trace_id = excluded.trace_id
         returning id`,
        [JSON.stringify(records), manifest.manifestId, manifest.generatedAt],
      );
      if (imported.rowCount !== manifest.events.length) {
        throw new Error('恢复库中的删除事件与独立清单冲突');
      }
      report.importedEventCount = imported.rowCount;
      await client.query(
        `select setval(
           pg_get_serial_sequence($1, 'event_sequence'),
           (select max(event_sequence) from ${quotedSchema}.deletion_events),
           true
         )`,
        [`${schema}.deletion_events`],
      );
    }

    const finalEvents = latestEvents(manifest.events);
    const deletedAccounts = new Set(
      finalEvents
        .filter((event) => event.eventType === 'account_delete')
        .map((event) => event.userId),
    );

    for (const userId of deletedAccounts) {
      await client.query(
        `update ${quotedSchema}.resume_versions set source_version_id = null
          where user_id = $1 and source_version_id is not null`,
        [userId],
      );
      await client.query(`delete from ${quotedSchema}.resume_versions where user_id = $1`, [
        userId,
      ]);
      await client.query(`delete from ${quotedSchema}.idempotency_requests where user_id = $1`, [
        userId,
      ]);
      await client.query(`delete from ${quotedSchema}.audit_events where actor_user_id = $1`, [
        userId,
      ]);
      await client.query(`delete from ${quotedSchema}.resumes where user_id = $1`, [userId]);
      await client.query(`delete from ${quotedSchema}.auth_accounts where user_id = $1`, [userId]);
      await client.query(`delete from ${quotedSchema}.auth_users where id = $1`, [userId]);
      const deleted = await client.query(`delete from ${quotedSchema}.users where id = $1`, [
        userId,
      ]);
      report.accountsDeleted += deleted.rowCount ?? 0;
    }

    for (const event of finalEvents) {
      if (event.resourceType !== 'resume' || deletedAccounts.has(event.userId)) continue;
      if (event.eventType === 'hard_delete') {
        await client.query(
          `update ${quotedSchema}.resume_versions set source_version_id = null
            where resume_id = $1 and source_version_id is not null`,
          [event.resourceId],
        );
        await client.query(`delete from ${quotedSchema}.resume_versions where resume_id = $1`, [
          event.resourceId,
        ]);
        await client.query(
          `delete from ${quotedSchema}.idempotency_requests
            where resource_type = 'resume' and resource_id = $1`,
          [event.resourceId],
        );
        await client.query(
          `delete from ${quotedSchema}.audit_events
            where (resource_type = 'resume' and resource_id = $1)
               or metadata ->> 'sourceResumeId' = $1::text`,
          [event.resourceId],
        );
        const deleted = await client.query(`delete from ${quotedSchema}.resumes where id = $1`, [
          event.resourceId,
        ]);
        report.resumesHardDeleted += deleted.rowCount ?? 0;
        continue;
      }
      if (event.eventType === 'soft_delete') {
        const deleted = await client.query(
          `update ${quotedSchema}.resumes
              set deleted_at = $2, restore_until = $3,
                  revision = greatest(revision, $4::bigint), updated_at = greatest(updated_at, $2)
            where id = $1 and user_id = $5`,
          [event.resourceId, event.occurredAt, event.restoreUntil, event.revision, event.userId],
        );
        report.resumesSoftDeleted += deleted.rowCount ?? 0;
        continue;
      }
      const restored = await client.query(
        `update ${quotedSchema}.resumes
            set deleted_at = null, restore_until = null,
                revision = greatest(revision, $2::bigint), updated_at = greatest(updated_at, $3)
          where id = $1 and user_id = $4`,
        [event.resourceId, event.revision, event.occurredAt, event.userId],
      );
      if (restored.rowCount !== 1) {
        throw new Error('恢复事件对应的简历不在备份中，恢复目标必须保持隔离');
      }
      report.resumesRestored += 1;
    }

    await client.query('commit');
    return report;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export function createDeletionManifest(
  events: readonly DeletionManifestEvent[],
  metadata: { manifestId: string; generatedAt: string },
): DeletionManifest {
  validateEvents(events);
  if (!uuidPattern.test(metadata.manifestId)) throw new Error('删除清单 ID 无效');
  if (!isIsoTimestamp(metadata.generatedAt)) throw new Error('删除清单生成时间无效');
  const copiedEvents = events.map((event) => ({ ...event }));
  const payload = manifestPayload({
    schemaVersion: 1,
    manifestId: metadata.manifestId,
    generatedAt: metadata.generatedAt,
    firstSequence: copiedEvents[0]?.sequence ?? '0',
    throughSequence: copiedEvents.at(-1)?.sequence ?? '0',
    eventCount: copiedEvents.length,
    events: copiedEvents,
  });
  return { ...payload, payloadSha256: payloadHash(payload) };
}

export function validateDeletionManifest(
  manifest: DeletionManifest,
  expected: { expectedThroughSequence: string; expectedPayloadSha256?: string },
): void {
  if (manifest.schemaVersion !== 1) throw new Error('删除清单版本不受支持');
  if (!uuidPattern.test(manifest.manifestId) || !isIsoTimestamp(manifest.generatedAt)) {
    throw new Error('删除清单元数据无效');
  }
  if (
    !nonNegativeIntegerPattern.test(manifest.firstSequence) ||
    !nonNegativeIntegerPattern.test(manifest.throughSequence) ||
    !nonNegativeIntegerPattern.test(expected.expectedThroughSequence)
  ) {
    throw new Error('删除清单水位无效');
  }
  if (!Number.isSafeInteger(manifest.eventCount) || manifest.eventCount < 0) {
    throw new Error('删除清单事件数量无效');
  }
  if (manifest.eventCount !== manifest.events.length) throw new Error('删除清单事件数量不匹配');
  validateEvents(manifest.events);
  const firstSequence = manifest.events[0]?.sequence ?? '0';
  const throughSequence = manifest.events.at(-1)?.sequence ?? '0';
  if (
    manifest.firstSequence !== firstSequence ||
    manifest.throughSequence !== throughSequence ||
    manifest.throughSequence !== expected.expectedThroughSequence
  ) {
    throw new Error('删除清单水位不匹配，恢复目标必须保持隔离');
  }
  if (!sha256Pattern.test(manifest.payloadSha256)) throw new Error('删除清单 hash 无效');
  const actualHash = payloadHash(manifestPayload(manifest));
  if (manifest.payloadSha256 !== actualHash) throw new Error('删除清单 hash 校验失败');
  if (
    expected.expectedPayloadSha256 !== undefined &&
    manifest.payloadSha256 !== expected.expectedPayloadSha256
  ) {
    throw new Error('删除清单独立 hash 不匹配，恢复目标必须保持隔离');
  }
}
