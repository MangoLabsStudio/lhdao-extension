import { describe, expect, it } from 'vitest'
import { CandidateStore } from '../zktls/discovery/candidate-store'
import { dynamicValue, redact } from '../zktls/discovery/redaction'
import { parseDiscoveryResponse } from '../zktls/discovery/response-contract'

describe('discovery business timestamps', () => {
  it('preserves valid ISO and named Unix seconds/milliseconds without weakening secret redaction', () => {
    expect(
      redact({
        created_at: '2026-09-01T08:00:00.000Z',
        timestamp: '1788249600',
        updatedAt: '1788249600000',
        amount: '125.50',
      }),
    ).toEqual({
      created_at: '2026-09-01T08:00:00.000Z',
      timestamp: '1788249600',
      updatedAt: '1788249600000',
      amount: '125.50',
    })
    for (const value of [
      '2026-02-30T08:00:00.000Z',
      '2026-09-01T25:00:00Z',
      '1788249600000000000000',
    ])
      expect(redact(value, 'timestamp')).toBe('[REDACTED]')
    for (const key of [
      'account',
      'wallet',
      'id',
      'token',
      'cookie',
      'authorization',
      'nonce',
      'cursor',
    ])
      expect(redact('2026-09-01T08:00:00.000Z', key)).toBe('[REDACTED]')
    expect(
      redact('2026-09-01T08:00:00.000Z', 'created_at', [
        '2026-09-01T08:00:00.000Z',
      ]),
    ).toBe('[REDACTED]')
    expect(redact('1788249600', 'timestamp', ['1788249600'])).toBe('[REDACTED]')
    expect(dynamicValue('2026-09-01T08:00:00.000Z')).toBe(true)
  })
  it('keeps date-window preview data and the public response contract consistent', () => {
    const rows = [
      { created_at: '2026-09-01T08:00:00.000Z', amount: '125.50' },
      { created_at: '2026-09-02T08:00:00.000Z', amount: '74.50' },
    ]
    const store = new CandidateStore()
    store.add({
      method: 'GET',
      url: 'https://api.example/history',
      documentUrl: 'https://client.example/history',
      requestBody: '',
      responseBody: JSON.stringify(rows),
      contentType: 'application/json',
    })
    const result = {
      type: 'discovery-result',
      requestType: 'start-discovery',
      correlationId: 'time-test-123',
      ok: true,
      snapshot: {
        schema: 1,
        sessionId: 'session-time-123',
        pageOrigin: 'https://client.example',
        status: 'ready',
        reason: null,
        startedAt: 0,
        expiresAt: 900000,
        ...store.snapshot(),
      },
    }
    expect(store.snapshot().candidates[0].samples[0].response).toEqual(rows)
    expect(
      rows.filter(
        (row) =>
          Date.parse(row.created_at) >= Date.parse('2026-09-02T00:00:00Z'),
      ),
    ).toHaveLength(1)
    expect(
      parseDiscoveryResponse(result, {
        type: 'start-discovery',
        correlationId: 'time-test-123',
        targetUrl: 'https://client.example/history',
      }),
    ).toEqual(result)
  })
})
