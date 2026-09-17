import { createHash, randomUUID } from 'node:crypto';
import { Client, Pool } from 'pg';
import { canonical, SaveError, validateEnvelope, type Envelope, type Receipt, type Snapshot } from './protocol.js';

export type SaveStoreHooks = { afterResumeUpdate?: () => Promise<void> | void };
export class PostgresSaveStore {
  constructor(private readonly pool: Pool, private readonly schema = 'public') {
    if (!/^[a-z][a-z0-9_]*$/.test(schema)) throw new Error('Unsafe schema name');
  }
  private table(name: string): string { return `"${this.schema}"."${name}"`; }
  async migrate(): Promise<void> {
    await this.pool.query(`CREATE SCHEMA IF NOT EXISTS "${this.schema}"`);
    await this.pool.query(`
      CREATE TABLE ${this.table('resumes')} (
        id uuid PRIMARY KEY, user_id uuid NOT NULL, document jsonb NOT NULL,
        revision bigint NOT NULL CHECK (revision > 0), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (id, user_id)
      );
      CREATE TABLE ${this.table('resume_versions')} (
        id uuid PRIMARY KEY, resume_id uuid NOT NULL, user_id uuid NOT NULL,
        revision bigint NOT NULL, snapshot jsonb NOT NULL, content_hash text NOT NULL,
        reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        UNIQUE (resume_id, revision),
        FOREIGN KEY (resume_id, user_id) REFERENCES ${this.table('resumes')}(id, user_id)
      );
      CREATE TABLE ${this.table('idempotency_requests')} (
        user_id uuid NOT NULL, operation text NOT NULL, key uuid NOT NULL,
        request_hash text NOT NULL, status text NOT NULL CHECK (status IN ('processing','committed')),
        response jsonb, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
        PRIMARY KEY (user_id, operation, key)
      );
    `);
  }
  async seed(resumeId: string, userId: string, document: Snapshot): Promise<void> {
    const hash = digest(canonical(document));
    const client = await this.pool.connect();
    await client.query('BEGIN');
    try {
      await client.query(`INSERT INTO ${this.table('resumes')}(id,user_id,document,revision) VALUES($1,$2,$3,1)`, [resumeId, userId, document]);
      await client.query(`INSERT INTO ${this.table('resume_versions')}(id,resume_id,user_id,revision,snapshot,content_hash,reason) VALUES($1,$2,$3,1,$4,$5,'create')`, [randomUUID(), resumeId, userId, document, hash]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  async save(userId: string, envelope: Envelope, hooks: SaveStoreHooks = {}): Promise<Receipt> {
    validateEnvelope(envelope);
    const client = await this.pool.connect();
    const requestHash = digest(canonical({
      resumeId: envelope.resumeId, baseRevision: envelope.baseRevision,
      clientSeq: envelope.clientSeq, document: envelope.document,
    }));
    try {
      await client.query('BEGIN');
      const claimed = await client.query(`
        INSERT INTO ${this.table('idempotency_requests')}(user_id,operation,key,request_hash,status)
        VALUES($1,'resume.save',$2,$3,'processing') ON CONFLICT DO NOTHING RETURNING key`,
      [userId, envelope.key, requestHash]);
      if (!claimed.rowCount) {
        const existing = await client.query<{ request_hash: string; status: string; response: Receipt | null }>(`
          SELECT request_hash,status,response FROM ${this.table('idempotency_requests')}
          WHERE user_id=$1 AND operation='resume.save' AND key=$2 FOR UPDATE`, [userId, envelope.key]);
        const row = existing.rows[0];
        if (!row) throw new Error('IDEMPOTENCY_ROW_MISSING');
        if (row.request_hash !== requestHash) throw new SaveError('IDEMPOTENCY_KEY_REUSED', 409);
        if (row.status !== 'committed' || !row.response) throw new SaveError('REQUEST_IN_PROGRESS', 409);
        await client.query('COMMIT');
        return row.response;
      }
      const updated = await client.query<{ revision: string; saved_at: Date }>(`
        UPDATE ${this.table('resumes')} SET document=$1,revision=revision+1,updated_at=clock_timestamp()
        WHERE id=$2 AND user_id=$3 AND revision=$4::bigint
        RETURNING revision::text,updated_at AS saved_at`,
      [envelope.document, envelope.resumeId, userId, envelope.baseRevision]);
      if (!updated.rowCount) {
        const owned = await client.query(`SELECT revision FROM ${this.table('resumes')} WHERE id=$1 AND user_id=$2`, [envelope.resumeId, userId]);
        throw new SaveError(owned.rowCount ? 'REVISION_CONFLICT' : 'RESUME_NOT_FOUND', owned.rowCount ? 412 : 404);
      }
      await hooks.afterResumeUpdate?.();
      const revision = updated.rows[0]!.revision;
      const versionId = randomUUID();
      const contentHash = digest(canonical(envelope.document));
      await client.query(`INSERT INTO ${this.table('resume_versions')}(id,resume_id,user_id,revision,snapshot,content_hash,reason)
        VALUES($1,$2,$3,$4::bigint,$5,$6,'autosave')`, [versionId, envelope.resumeId, userId, revision, envelope.document, contentHash]);
      const receipt: Receipt = {
        resumeId: envelope.resumeId, revision, versionId, acknowledgedSeq: envelope.clientSeq,
        contentHash, savedAt: updated.rows[0]!.saved_at.toISOString(),
      };
      await client.query(`UPDATE ${this.table('idempotency_requests')} SET status='committed',response=$1 WHERE user_id=$2 AND operation='resume.save' AND key=$3`, [receipt, userId, envelope.key]);
      await client.query('COMMIT');
      return receipt;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
}
export async function connectPool(url: string): Promise<Pool> {
  const pool = new Pool({ connectionString: url, max: 8, connectionTimeoutMillis: 5_000 });
  await pool.query('SELECT 1');
  return pool;
}
export async function dropSchema(url: string, schema: string): Promise<void> {
  if (!/^save_[a-f0-9]+$/.test(schema)) throw new Error('Unsafe test schema');
  const client = new Client({ connectionString: url });
  await client.connect();
  try { await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
  finally { await client.end(); }
}
function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
