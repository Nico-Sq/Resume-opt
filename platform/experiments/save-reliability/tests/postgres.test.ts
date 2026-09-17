import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after, before } from 'node:test';
import type { Pool } from 'pg';
import { SaveError, type Envelope, type Snapshot } from '../src/protocol.js';
import { connectPool, dropSchema, PostgresSaveStore } from '../src/postgres-store.js';

const databaseUrl = process.env.PG_TEST_URL;
if (!databaseUrl) throw new Error('PG_TEST_URL is required; run scripts/setup-databases.ts first.');
const schema = `save_${randomUUID().replaceAll('-', '')}`;
const userId = randomUUID();
const otherUserId = randomUUID();
const resumeId = randomUUID();
const initial = { name: '初始版本' } satisfies Snapshot;
let pool: Pool;
let store: PostgresSaveStore;
const envelope = (overrides: Partial<Envelope> = {}): Envelope => ({
  resumeId,
  key: randomUUID(),
  baseRevision: '1',
  clientSeq: 1,
  document: { name: '保存内容' },
  ...overrides,
});

before(async () => {
  pool = await connectPool(databaseUrl);
  store = new PostgresSaveStore(pool, schema);
  await store.migrate();
  await store.seed(resumeId, userId, initial);
});
after(async () => {
  await pool.end();
  await dropSchema(databaseUrl, schema);
});

test('CAS save writes the current row, immutable version and receipt atomically', async () => {
  const id = randomUUID();
  await store.seed(id, userId, initial);
  const request = envelope({ resumeId: id, document: { name: '第二版' }, clientSeq: 8 });
  const result = await store.save(userId, request);
  assert.equal(result.revision, '2');
  assert.equal(result.acknowledgedSeq, 8);
  const rows = await pool.query(
    `SELECT revision::text,document FROM "${schema}".resumes WHERE id=$1`,
    [id],
  );
  assert.deepEqual(rows.rows[0], { revision: '2', document: { name: '第二版' } });
  const versions = await pool.query(
    `SELECT revision::text,snapshot FROM "${schema}".resume_versions WHERE resume_id=$1 ORDER BY revision`,
    [id],
  );
  assert.deepEqual(
    versions.rows.map((row) => row.revision),
    ['1', '2'],
  );
  assert.deepEqual(versions.rows[0]!.snapshot, initial);
});

test('two different writes from one revision yield one commit and one 412', async () => {
  const id = randomUUID();
  await store.seed(id, userId, initial);
  const requests = [
    store.save(userId, envelope({ resumeId: id, document: { winner: 'A' }, key: randomUUID() })),
    store.save(userId, envelope({ resumeId: id, document: { winner: 'B' }, key: randomUUID() })),
  ];
  const settled = await Promise.allSettled(requests);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  const rejection = settled.find((result) => result.status === 'rejected');
  assert.ok(rejection?.status === 'rejected' && rejection.reason instanceof SaveError);
  assert.equal(rejection.reason.status, 412);
  const count = await pool.query(
    `SELECT count(*)::int AS count FROM "${schema}".resume_versions WHERE resume_id=$1`,
    [id],
  );
  assert.equal(count.rows[0]!.count, 2);
});

test('same key and body replay returns one receipt; changed body is rejected', async () => {
  const id = randomUUID();
  await store.seed(id, userId, initial);
  const request = envelope({ resumeId: id, key: randomUUID(), document: { name: '一次提交' } });
  const [first, replay] = await Promise.all([
    store.save(userId, request),
    store.save(userId, request),
  ]);
  assert.deepEqual(replay, first);
  await assert.rejects(
    () => store.save(userId, { ...request, document: { name: '偷换内容' } }),
    (error: unknown) => error instanceof SaveError && error.status === 409,
  );
  const count = await pool.query(
    `SELECT count(*)::int AS count FROM "${schema}".resume_versions WHERE resume_id=$1`,
    [id],
  );
  assert.equal(count.rows[0]!.count, 2);
});

test('a failure after CAS rolls the row, version and idempotency claim back', async () => {
  const id = randomUUID();
  await store.seed(id, userId, initial);
  const request = envelope({ resumeId: id, key: randomUUID(), document: { name: '必须原子' } });
  await assert.rejects(
    () =>
      store.save(userId, request, {
        afterResumeUpdate: () => {
          throw new Error('injected');
        },
      }),
    /injected/,
  );
  const state = await pool.query(
    `SELECT revision::text,document FROM "${schema}".resumes WHERE id=$1`,
    [id],
  );
  assert.deepEqual(state.rows[0], { revision: '1', document: initial });
  const idem = await pool.query(
    `SELECT count(*)::int AS count FROM "${schema}".idempotency_requests WHERE key=$1`,
    [request.key],
  );
  assert.equal(idem.rows[0]!.count, 0);
  const retried = await store.save(userId, request);
  assert.equal(retried.revision, '2');
});

test('another owner receives a non-enumerating not-found result and no write', async () => {
  await assert.rejects(
    () => store.save(otherUserId, envelope()),
    (error: unknown) => error instanceof SaveError && error.status === 404,
  );
  const state = await pool.query(`SELECT revision::text FROM "${schema}".resumes WHERE id=$1`, [
    resumeId,
  ]);
  assert.equal(state.rows[0]!.revision, '1');
});
