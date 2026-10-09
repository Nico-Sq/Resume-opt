import { describe, expect, it, vi } from 'vitest';

import {
  createOperationalAlert,
  runWithOperationalAlert,
  type OperationalAlertEvent,
  type OperationalAlertType,
} from '@resume/infrastructure/operational-alert';

describe('operational alerts', () => {
  it.each<OperationalAlertType>([
    'auth-mail-delivery-failed',
    'privacy-cleanup-failed',
    'backup-restore-failed',
  ])('delivers a safe allowlisted %s event without the injected secret', async (type) => {
    const canary = `secret-canary-${type}`;
    const received: OperationalAlertEvent[] = [];

    await expect(
      runWithOperationalAlert({
        type,
        context: {
          environment: 'test',
          release: 'v0.2-test',
          recipient: 'test-operator',
          traceId: 'trace-031',
          now: () => new Date('2026-10-09T00:00:00.000Z'),
        },
        receiver: (event) => {
          received.push(event);
        },
        operation: () => Promise.reject(new Error(`password=${canary}; resumeBody=${canary}`)),
      }),
    ).rejects.not.toThrow(canary);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      schemaVersion: 1,
      environment: 'test',
      release: 'v0.2-test',
      recipient: 'test-operator',
      traceId: 'trace-031',
    });
    expect(JSON.stringify(received)).not.toContain(canary);
    expect(Object.keys(received[0] ?? {}).sort()).toEqual(
      [
        'alertId',
        'environment',
        'failureCode',
        'occurredAt',
        'recipient',
        'release',
        'resourceType',
        'runbookId',
        'schemaVersion',
        'severity',
        'traceId',
      ].sort(),
    );
  });

  it('falls back to a safe recipient when labels are not allowlisted', () => {
    const event = createOperationalAlert('privacy-cleanup-failed', {
      environment: 'test password=secret',
      release: 'release/secret',
      recipient: 'mail body: secret',
      traceId: 'trace secret',
    });

    expect(event).toMatchObject({
      environment: 'unknown',
      release: 'local',
      recipient: 'invoking-operator-stderr',
    });
    expect(event).not.toHaveProperty('traceId');
  });

  it('uses a safe stderr fallback when the configured receiver fails', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await expect(
      runWithOperationalAlert({
        type: 'backup-restore-failed',
        context: { environment: 'test' },
        receiver: () => Promise.reject(new Error('receiver-secret-canary')),
        operation: () => Promise.reject(new Error('operation-secret-canary')),
      }),
    ).rejects.toThrow('数据库备份恢复演练失败');

    const output = stderr.mock.calls.flat().join(' ');
    expect(output).toContain('BACKUP_RESTORE_FAILED');
    expect(output).not.toContain('secret-canary');
    stderr.mockRestore();
  });
});
