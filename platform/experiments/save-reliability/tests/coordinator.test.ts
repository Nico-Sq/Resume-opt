import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { SaveCoordinator, type Draft, type DraftStorage } from '../src/coordinator.js';
import {
  SaveError,
  canonical,
  type Envelope,
  type Receipt,
  type Snapshot,
} from '../src/protocol.js';

const userId = randomUUID();
const resumeId = randomUUID();
const base = { name: '初始' } satisfies Snapshot;
const draft = (): Draft => ({
  userId,
  resumeId,
  tabId: randomUUID(),
  revision: '1',
  baseSnapshot: base,
  document: base,
  localSeq: 0,
  ackedSeq: 0,
  pending: null,
  phase: 'synced',
});
const receipt = (envelope: Envelope): Receipt => ({
  resumeId: envelope.resumeId,
  revision: (BigInt(envelope.baseRevision) + 1n).toString(),
  versionId: randomUUID(),
  acknowledgedSeq: envelope.clientSeq,
  contentHash: canonical(envelope.document),
  savedAt: new Date().toISOString(),
});
class MemoryStorage implements DraftStorage {
  writes: Draft[] = [];
  failures = 0;
  async write(_key: string, value: Draft): Promise<void> {
    if (this.failures-- > 0) throw new Error('quota');
    this.writes.push(structuredClone(value));
  }
}

test('an old ACK cannot overwrite input typed while the request is in flight', async () => {
  const storage = new MemoryStorage();
  const sent: Envelope[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const coordinator = new SaveCoordinator(
    draft(),
    storage,
    async (envelope) => {
      sent.push(structuredClone(envelope));
      if (sent.length === 1) await firstGate;
      return receipt(envelope);
    },
    randomUUID,
  );
  coordinator.edit({ name: 'A' });
  const flushing = coordinator.flush();
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.edit({ name: 'AB' });
  releaseFirst();
  await flushing;
  const state = coordinator.snapshot();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0]!.document, { name: 'A' });
  assert.deepEqual(sent[1]!.document, { name: 'AB' });
  assert.equal(sent[1]!.baseRevision, '2');
  assert.deepEqual(state.document, { name: 'AB' });
  assert.equal(state.revision, '3');
  assert.equal(state.phase, 'synced');
});

test('a lost response retains the exact frozen envelope for retry', async () => {
  const storage = new MemoryStorage();
  const attempts: Envelope[] = [];
  const coordinator = new SaveCoordinator(
    draft(),
    storage,
    async (envelope) => {
      attempts.push(structuredClone(envelope));
      if (attempts.length === 1) throw new Error('connection reset after commit');
      return receipt(envelope);
    },
    randomUUID,
  );
  coordinator.edit({ name: '可靠' });
  await coordinator.flush();
  assert.equal(coordinator.snapshot().phase, 'retryWait');
  await coordinator.flush();
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(coordinator.snapshot().phase, 'synced');
});

test('conflict pauses uploads and preserves the local branch', async () => {
  const coordinator = new SaveCoordinator(
    draft(),
    new MemoryStorage(),
    async () => {
      throw new SaveError('REVISION_CONFLICT', 412);
    },
    randomUUID,
  );
  coordinator.edit({ name: '本地分支' });
  await coordinator.flush();
  const state = coordinator.snapshot();
  assert.equal(state.phase, 'conflict');
  assert.deepEqual(state.document, { name: '本地分支' });
  assert.deepEqual(state.pending?.document, { name: '本地分支' });
});

test('local storage failure is visible but does not invent a cloud failure', async () => {
  const storage = new MemoryStorage();
  storage.failures = 99;
  const coordinator = new SaveCoordinator(
    draft(),
    storage,
    async (envelope) => receipt(envelope),
    randomUUID,
  );
  coordinator.edit({ name: '云端救援' });
  await coordinator.backupSettled();
  assert.equal(coordinator.localBackupAvailable, false);
  await coordinator.flush();
  assert.equal(coordinator.snapshot().phase, 'synced');
  assert.equal(coordinator.localBackupAvailable, false);
});

test('authentication cannot resume under another account', async () => {
  const coordinator = new SaveCoordinator(
    draft(),
    new MemoryStorage(),
    async () => {
      throw new SaveError('SESSION_EXPIRED', 401);
    },
    randomUUID,
  );
  coordinator.edit({ name: '私有草稿' });
  await coordinator.flush();
  assert.equal(coordinator.snapshot().phase, 'authPaused');
  assert.throws(() => coordinator.resumeAuthentication(randomUUID()), /ACCOUNT_MISMATCH/);
});
