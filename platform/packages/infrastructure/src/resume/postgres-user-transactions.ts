import { randomUUID } from 'node:crypto';

import {
  IdempotencyKeyReusedError,
  IdempotencyRequestInProgressError,
  ResourceNotFoundError,
  RevisionConflictError,
  TemplateUnavailableError,
  type PersistedResume,
  type ResumeRepository,
  type SaveReceipt,
  type SaveResumeCommand,
  type SaveResumeResult,
  type UserTransaction,
  type UserTransactionManager,
} from '@resume/application';
import type { Pool, PoolClient } from 'pg';

import { sha256CanonicalJson } from './canonical-json';

const safeIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;

class PostgresResumeRepository implements ResumeRepository {
  constructor(
    private readonly client: PoolClient,
    private readonly userId: string,
  ) {}

  async findActiveById(resumeId: string): Promise<PersistedResume | null> {
    const result = await this.client.query<{
      id: string;
      user_id: string;
      title: string;
      document: unknown;
      revision: string;
      schema_version: number;
      template_id: string;
      template_version: string;
      updated_at: Date;
    }>(
      `select id, user_id, title, document, revision, schema_version,
              template_id, template_version, updated_at
         from resumes
        where id = $1 and user_id = $2 and deleted_at is null`,
      [resumeId, this.userId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      id: row.id,
      userId: row.user_id,
      title: row.title,
      document: row.document,
      revision: BigInt(row.revision),
      schemaVersion: row.schema_version,
      templateId: row.template_id,
      templateVersion: row.template_version,
      updatedAt: row.updated_at,
    };
  }

  async saveDocument(command: SaveResumeCommand): Promise<SaveResumeResult> {
    const requestHash = sha256CanonicalJson({
      resumeId: command.resumeId,
      baseRevision: command.baseRevision,
      clientSeq: command.clientSeq,
      document: command.document,
    });
    const claimed = await this.client.query(
      `insert into idempotency_requests
        (user_id, operation, key, request_hash, status, expires_at)
       values ($1, 'resume.save', $2, $3, 'processing', clock_timestamp() + interval '7 days')
       on conflict do nothing
       returning key`,
      [this.userId, command.idempotencyKey, requestHash],
    );

    if (!claimed.rowCount) {
      const existing = await this.client.query<{
        request_hash: string;
        status: string;
        response_body: SaveReceipt | null;
      }>(
        `select request_hash, status, response_body
           from idempotency_requests
          where user_id = $1 and operation = 'resume.save' and key = $2
          for update`,
        [this.userId, command.idempotencyKey],
      );
      const row = existing.rows[0];
      if (!row) throw new Error('幂等声明在冲突后不可见');
      if (row.request_hash !== requestHash) throw new IdempotencyKeyReusedError();
      if (row.status !== 'completed' || !row.response_body) {
        throw new IdempotencyRequestInProgressError();
      }
      const active = await this.client.query(
        `select 1 from resumes
          where id = $1 and user_id = $2 and deleted_at is null`,
        [command.resumeId, this.userId],
      );
      if (!active.rowCount) throw new ResourceNotFoundError();
      return { receipt: row.response_body, replayed: true };
    }

    const template = await this.client.query<{ renderer_version: string }>(
      `select renderer_version from templates
        where template_id = $1 and version = $2 and status <> 'draft'`,
      [command.document.templateId, command.document.templateVersion],
    );
    const templateRow = template.rows[0];
    if (!templateRow) throw new TemplateUnavailableError();

    const updated = await this.client.query<{
      revision: string;
      saved_at: Date;
      title: string;
    }>(
      `update resumes
          set document = $1::jsonb,
              revision = revision + 1,
              schema_version = $2,
              template_id = $3,
              template_version = $4,
              updated_at = clock_timestamp()
        where id = $5 and user_id = $6 and deleted_at is null
          and revision = $7::bigint
      returning revision::text, updated_at as saved_at, title`,
      [
        JSON.stringify(command.document),
        command.document.schemaVersion,
        command.document.templateId,
        command.document.templateVersion,
        command.resumeId,
        this.userId,
        command.baseRevision,
      ],
    );
    const updatedRow = updated.rows[0];
    if (!updatedRow) {
      const current = await this.client.query<{ revision: string }>(
        `select revision::text from resumes
          where id = $1 and user_id = $2 and deleted_at is null`,
        [command.resumeId, this.userId],
      );
      const currentRow = current.rows[0];
      if (!currentRow) throw new ResourceNotFoundError();
      throw new RevisionConflictError(currentRow.revision);
    }

    const versionId = randomUUID();
    const contentHash = sha256CanonicalJson(command.document);
    await this.client.query(
      `insert into resume_versions
        (id, resume_id, user_id, revision, title_snapshot, schema_version,
         template_id, template_version, renderer_version, snapshot, content_hash, reason)
       values ($1, $2, $3, $4::bigint, $5, $6, $7, $8, $9, $10::jsonb, $11, 'autosave')`,
      [
        versionId,
        command.resumeId,
        this.userId,
        updatedRow.revision,
        updatedRow.title,
        command.document.schemaVersion,
        command.document.templateId,
        command.document.templateVersion,
        templateRow.renderer_version,
        JSON.stringify(command.document),
        contentHash,
      ],
    );

    const receipt: SaveReceipt = {
      resumeId: command.resumeId,
      revision: updatedRow.revision,
      versionId,
      acknowledgedSeq: command.clientSeq,
      savedAt: updatedRow.saved_at.toISOString(),
      contentHash,
    };
    await this.client.query(
      `update idempotency_requests
          set status = 'completed', response_body = $1::jsonb
        where user_id = $2 and operation = 'resume.save' and key = $3`,
      [JSON.stringify(receipt), this.userId, command.idempotencyKey],
    );
    await this.client.query(
      `insert into audit_events
        (id, actor_user_id, action, resource_type, resource_id, trace_id, result_code, metadata)
       values ($1, $2, 'resume.save', 'resume', $3, $4, 'SAVED', $5::jsonb)`,
      [
        randomUUID(),
        this.userId,
        command.resumeId,
        command.traceId,
        JSON.stringify({
          revision: receipt.revision,
          versionId: receipt.versionId,
          acknowledgedSeq: receipt.acknowledgedSeq,
        }),
      ],
    );
    return { receipt, replayed: false };
  }
}

export class PostgresUserTransactionManager implements UserTransactionManager {
  readonly #schema: string;

  constructor(
    private readonly pool: Pool,
    schema = 'public',
  ) {
    if (!safeIdentifier.test(schema)) throw new Error('不安全的数据库 schema');
    this.#schema = schema;
  }

  async withUser<T>(
    userId: string,
    work: (transaction: UserTransaction) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query(`set local search_path to "${this.#schema}", public`);
      await client.query("select set_config('app.user_id', $1, true)", [userId]);
      const result = await work({ resumes: new PostgresResumeRepository(client, userId) });
      await client.query('commit');
      return result;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
