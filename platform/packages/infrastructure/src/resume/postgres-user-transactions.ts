import type {
  PersistedResume,
  ResumeReader,
  UserTransaction,
  UserTransactionManager,
} from '@resume/application';
import type { Pool, PoolClient } from 'pg';

const safeIdentifier = /^[a-z][a-z0-9_]{0,62}$/u;

class PostgresResumeReader implements ResumeReader {
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
      const result = await work({ resumes: new PostgresResumeReader(client, userId) });
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
