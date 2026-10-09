import { randomUUID } from 'node:crypto';

const alertDefinitions = {
  'auth-mail-delivery-failed': {
    severity: 'warning',
    resourceType: 'auth-mail',
    failureCode: 'AUTH_MAIL_DELIVERY_FAILED',
    runbookId: 'OPS-AUTH-MAIL-01',
    publicMessage: '认证邮件发送失败',
  },
  'privacy-cleanup-failed': {
    severity: 'critical',
    resourceType: 'privacy-cleanup',
    failureCode: 'PRIVACY_CLEANUP_FAILED',
    runbookId: 'OPS-PRIVACY-CLEANUP-01',
    publicMessage: '隐私清理任务失败',
  },
  'backup-restore-failed': {
    severity: 'critical',
    resourceType: 'database-backup',
    failureCode: 'BACKUP_RESTORE_FAILED',
    runbookId: 'OPS-DB-RESTORE-01',
    publicMessage: '数据库备份恢复演练失败',
  },
} as const;

export type OperationalAlertType = keyof typeof alertDefinitions;

export interface OperationalAlertContext {
  environment: string;
  release?: string;
  recipient?: string;
  traceId?: string;
  now?: () => Date;
}

export interface OperationalAlertEvent {
  schemaVersion: 1;
  alertId: string;
  occurredAt: string;
  environment: string;
  release: string;
  severity: 'warning' | 'critical';
  resourceType: 'auth-mail' | 'privacy-cleanup' | 'database-backup';
  failureCode: 'AUTH_MAIL_DELIVERY_FAILED' | 'PRIVACY_CLEANUP_FAILED' | 'BACKUP_RESTORE_FAILED';
  runbookId: 'OPS-AUTH-MAIL-01' | 'OPS-PRIVACY-CLEANUP-01' | 'OPS-DB-RESTORE-01';
  recipient: string;
  traceId?: string;
}

export type OperationalAlertReceiver = (event: OperationalAlertEvent) => void | Promise<void>;

const safeLabel = /^[a-z0-9][a-z0-9._:-]{0,79}$/iu;

function safeLabelOr(value: string | undefined, fallback: string): string {
  return value && safeLabel.test(value) ? value : fallback;
}

export function createOperationalAlert(
  type: OperationalAlertType,
  context: OperationalAlertContext,
): OperationalAlertEvent {
  const definition = alertDefinitions[type];
  return {
    schemaVersion: 1,
    alertId: randomUUID(),
    occurredAt: (context.now?.() ?? new Date()).toISOString(),
    environment: safeLabelOr(context.environment, 'unknown'),
    release: safeLabelOr(context.release, 'local'),
    severity: definition.severity,
    resourceType: definition.resourceType,
    failureCode: definition.failureCode,
    runbookId: definition.runbookId,
    recipient: safeLabelOr(context.recipient, 'invoking-operator-stderr'),
    ...(context.traceId && safeLabel.test(context.traceId) ? { traceId: context.traceId } : {}),
  };
}

export const stderrOperationalAlertReceiver: OperationalAlertReceiver = (event) => {
  process.stderr.write(`[operational-alert] ${JSON.stringify(event)}\n`);
};

export async function reportOperationalFailure(
  type: OperationalAlertType,
  context: OperationalAlertContext,
  receiver: OperationalAlertReceiver = stderrOperationalAlertReceiver,
): Promise<void> {
  const event = createOperationalAlert(type, context);
  try {
    await receiver(event);
  } catch {
    await stderrOperationalAlertReceiver({ ...event, recipient: 'invoking-operator-stderr' });
  }
}

export async function runWithOperationalAlert<T>(options: {
  type: OperationalAlertType;
  context: OperationalAlertContext;
  receiver?: OperationalAlertReceiver;
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    return await options.operation();
  } catch {
    await reportOperationalFailure(options.type, options.context, options.receiver);
    throw new Error(alertDefinitions[options.type].publicMessage);
  }
}
