import { describe, expect, it } from 'vitest'
import { buildExport, screenImages } from './prototype'

describe('prototype state catalog', () => {
  it('maps every supported screen to a PNG asset', () => {
    expect(Object.keys(screenImages)).toHaveLength(24)
    expect(Object.values(screenImages).every(name => name.endsWith('.png'))).toBe(true)
  })

  it('builds a portable test log payload', () => {
    const payload = buildExport([], 'session-1', '2026-09-16T00:00:00.000Z')
    expect(payload.schemaVersion).toBe(1)
    expect(payload.sessionId).toBe('session-1')
    expect(payload.eventCount).toBe(0)
  })
})
