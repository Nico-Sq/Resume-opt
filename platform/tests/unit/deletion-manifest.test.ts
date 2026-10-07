import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  createDeletionManifest,
  validateDeletionManifest,
  type DeletionManifestEvent,
} from '../../scripts/ops/deletion-manifest';

function event(overrides: Partial<DeletionManifestEvent> = {}): DeletionManifestEvent {
  return {
    sequence: '1',
    id: randomUUID(),
    resourceType: 'resume',
    resourceId: randomUUID(),
    userId: randomUUID(),
    eventType: 'soft_delete',
    revision: '2',
    occurredAt: '2026-10-08T00:00:00.000Z',
    restoreUntil: '2026-10-15T00:00:00.000Z',
    policyVersion: 1,
    traceId: randomUUID(),
    ...overrides,
  };
}

describe('deletion manifest contract', () => {
  it('creates a hashed full manifest with a stable high watermark', () => {
    const events = [
      event(),
      event({ sequence: '3', revision: '4', eventType: 'restore', restoreUntil: null }),
    ];
    const manifest = createDeletionManifest(events, {
      manifestId: randomUUID(),
      generatedAt: '2026-10-08T00:05:00.000Z',
    });

    expect(manifest.eventCount).toBe(2);
    expect(manifest.throughSequence).toBe('3');
    expect(manifest.payloadSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => {
      validateDeletionManifest(manifest, {
        expectedThroughSequence: '3',
        expectedPayloadSha256: manifest.payloadSha256,
      });
    }).not.toThrow();
  });

  it('fails closed for a missing tail, duplicate, out-of-order or mutated event', () => {
    const first = event();
    const second = event({
      sequence: '3',
      resourceId: first.resourceId,
      userId: first.userId,
      revision: '3',
    });
    const manifest = createDeletionManifest([first, second], {
      manifestId: randomUUID(),
      generatedAt: '2026-10-08T00:05:00.000Z',
    });

    const truncated = createDeletionManifest([first], {
      manifestId: randomUUID(),
      generatedAt: '2026-10-08T00:05:00.000Z',
    });
    expect(() => {
      validateDeletionManifest(truncated, { expectedThroughSequence: '3' });
    }).toThrow('水位不匹配');
    expect(() => {
      validateDeletionManifest(
        createDeletionManifest([first, { ...second, sequence: '1' }], {
          manifestId: randomUUID(),
          generatedAt: '2026-10-08T00:05:00.000Z',
        }),
        { expectedThroughSequence: '1' },
      );
    }).toThrow('严格递增');
    expect(() => {
      validateDeletionManifest(
        { ...manifest, events: [second, first] },
        { expectedThroughSequence: '3' },
      );
    }).toThrow('严格递增');
    expect(() => {
      validateDeletionManifest(
        {
          ...manifest,
          events: [{ ...first, occurredAt: '2026-10-08T00:00:01.000Z' }, second],
        },
        { expectedThroughSequence: '3' },
      );
    }).toThrow('hash');
  });

  it('rejects lifecycle events after a hard-delete terminal', () => {
    const resourceId = randomUUID();
    const userId = randomUUID();
    expect(() => {
      createDeletionManifest(
        [
          event({ resourceId, userId, eventType: 'hard_delete', restoreUntil: null }),
          event({
            sequence: '2',
            resourceId,
            userId,
            eventType: 'restore',
            revision: '3',
            restoreUntil: null,
          }),
        ],
        { manifestId: randomUUID(), generatedAt: '2026-10-08T00:05:00.000Z' },
      );
    }).toThrow('终态');
  });
});
