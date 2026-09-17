// Protocol spike: document is opaque JSON, NOT the production Resume schema.
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Snapshot = { [key: string]: Json };
export type Envelope = {
  resumeId: string;
  key: string;
  baseRevision: string;
  clientSeq: number;
  document: Snapshot;
};
export type Receipt = {
  resumeId: string;
  revision: string;
  versionId: string;
  acknowledgedSeq: number;
  contentHash: string;
  savedAt: string;
};
export class SaveError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
  }
}
export function canonical(value: Json): string {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value))
      throw new SaveError('INVALID_JSON', 422);
    if (value === undefined) throw new SaveError('INVALID_JSON', 422);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new SaveError('INVALID_JSON', 422);
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`)
    .join(',')}}`;
}
export function validateEnvelope(value: Envelope): void {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !uuid.test(value.resumeId) ||
    !uuid.test(value.key) ||
    !/^[1-9][0-9]{0,18}$/.test(value.baseRevision) ||
    BigInt(value.baseRevision) >= 9223372036854775807n ||
    !Number.isSafeInteger(value.clientSeq) ||
    value.clientSeq < 0 ||
    !value.document ||
    Array.isArray(value.document) ||
    typeof value.document !== 'object'
  ) {
    throw new SaveError('INVALID_ENVELOPE', 422);
  }
  const body = canonical(value.document);
  if (new TextEncoder().encode(body).length > 1024 * 1024)
    throw new SaveError('PAYLOAD_TOO_LARGE', 413);
}
