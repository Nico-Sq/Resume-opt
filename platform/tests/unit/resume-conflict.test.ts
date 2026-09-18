import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { createInitialResumeDocument } from '@resume/domain/resume';
import {
  buildThreeWayConflictChanges,
  ConflictSnapshotError,
  HttpConflictSnapshotTransport,
} from '../../apps/web/src/client/editor/conflict';

describe('three-way resume conflict summary', () => {
  it('distinguishes local-only, remote-only, matching and diverged changes', () => {
    const base = createInitialResumeDocument();
    const sectionIds = base.moduleOrder.slice(0, 4);
    const [localOnlyId, remoteOnlyId, sameId, divergedId] = sectionIds;
    if (!localOnlyId || !remoteOnlyId || !sameId || !divergedId) {
      throw new Error('fixture 模块不足');
    }
    const local = structuredClone(base);
    const remote = structuredClone(base);
    const localOnly = local.sectionsById[localOnlyId];
    const remoteOnly = remote.sectionsById[remoteOnlyId];
    const localSame = local.sectionsById[sameId];
    const remoteSame = remote.sectionsById[sameId];
    const localDiverged = local.sectionsById[divergedId];
    const remoteDiverged = remote.sectionsById[divergedId];
    if (
      !localOnly ||
      !remoteOnly ||
      !localSame ||
      !remoteSame ||
      !localDiverged ||
      !remoteDiverged
    ) {
      throw new Error('fixture 模块映射缺失');
    }
    localOnly.title = '仅本地';
    remoteOnly.title = '仅服务器';
    localSame.title = '双方一致';
    remoteSame.title = '双方一致';
    localDiverged.title = '本地分支';
    remoteDiverged.title = '服务器分支';

    expect(buildThreeWayConflictChanges(base, local, remote)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: `section:${localOnlyId}`, kind: 'local-only' }),
        expect.objectContaining({ key: `section:${remoteOnlyId}`, kind: 'remote-only' }),
        expect.objectContaining({ key: `section:${sameId}`, kind: 'same-change' }),
        expect.objectContaining({ key: `section:${divergedId}`, kind: 'diverged' }),
      ]),
    );
  });
});

describe('HttpConflictSnapshotTransport', () => {
  it('loads a validated remote snapshot and checks its ETag', async () => {
    const resumeId = randomUUID();
    const document = createInitialResumeDocument();
    const transport = new HttpConflictSnapshotTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { id: resumeId, document, revision: '4' },
            traceId: randomUUID(),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: '"4"' },
          },
        ),
      ),
    );

    await expect(transport.loadCurrent(resumeId)).resolves.toEqual({
      resumeId,
      document,
      revision: '4',
    });
  });

  it('keeps browser fetch bound to the global receiver', async () => {
    const resumeId = randomUUID();
    const document = createInitialResumeDocument();
    let receiverMatched = false;
    vi.stubGlobal('fetch', function (this: unknown) {
      receiverMatched = this === globalThis;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: { id: resumeId, document, revision: '2' },
            traceId: randomUUID(),
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json', ETag: '"2"' },
          },
        ),
      );
    });
    try {
      await new HttpConflictSnapshotTransport().loadCurrent(resumeId);
      expect(receiverMatched).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects a mismatched ETag instead of presenting an unverified remote snapshot', async () => {
    const resumeId = randomUUID();
    const transport = new HttpConflictSnapshotTransport(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            data: { id: resumeId, document: createInitialResumeDocument(), revision: '3' },
            traceId: randomUUID(),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ETag: '"2"' } },
        ),
      ),
    );

    const error = await transport.loadCurrent(resumeId).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ConflictSnapshotError);
    expect((error as ConflictSnapshotError).kind).toBe('fatal');
  });
});
