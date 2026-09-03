import { describe, expect, it, vi } from 'vitest'
import { CandidateStore } from '../zktls/discovery/candidate-store'
import { parseDiscoveryResponse } from '../zktls/discovery/response-contract'

const request = {
  type: 'start-discovery' as const,
  correlationId: 'request-123',
  targetUrl: 'https://client.example/app',
}
function valid() {
  const store = new CandidateStore()
  store.add({
    method: 'GET',
    url: 'https://api.example/balance',
    documentUrl: request.targetUrl,
    requestBody: '',
    contentType: 'application/json',
    responseBody: '{"balance":42}',
  })
  return {
    type: 'discovery-result',
    requestType: request.type,
    correlationId: request.correlationId,
    ok: true,
    snapshot: {
      schema: 1,
      sessionId: 'session-123',
      status: 'ready',
      reason: null,
      pageOrigin: 'https://client.example',
      startedAt: 0,
      expiresAt: 900000,
      ...structuredClone(store.snapshot()),
    },
  }
}
describe('exact discovery response boundary', () => {
  it('accepts a real redacted snapshot as an independent deeply frozen copy', () => {
    const input = valid()
    const result = parseDiscoveryResponse(input, request)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
    expect(
      Object.isFrozen(
        result?.ok && result.snapshot.candidates[0].samples[0].response,
      ),
    ).toBe(true)
  })
  it('accepts only exact errors and matching request/session identity', () => {
    const failure = {
      type: 'discovery-result',
      requestType: request.type,
      correlationId: request.correlationId,
      ok: false,
      code: 'ATTACH_FAILED',
    }
    expect(parseDiscoveryResponse(failure, request)).toEqual(failure)
    for (const input of [
      { ...failure, code: 'private-error' },
      { ...failure, stack: 'raw' },
      { ...valid(), correlationId: 'other' },
    ])
      expect(parseDiscoveryResponse(input, request)).toBeNull()
    const input = valid()
    input.requestType = 'get-discovery-snapshot' as typeof input.requestType
    expect(
      parseDiscoveryResponse(input, {
        type: 'get-discovery-snapshot',
        correlationId: request.correlationId,
        sessionId: 'wrong',
      }),
    ).toBeNull()
  })
  it('rejects extras, wrong enums/types, and candidate/sample/body quotas', () => {
    const mutations: Array<(input: ReturnType<typeof valid>) => void> = [
      (input) => {
        Object.assign(input, { stack: 'raw' })
      },
      (input) => {
        Object.assign(input.snapshot, { rawBody: 'raw' })
      },
      (input) => {
        Object.assign(input, { ok: 'true' })
      },
      (input) => {
        input.snapshot.schema = 2
      },
      (input) => {
        input.snapshot.status = 'bad'
      },
      (input) => {
        Object.assign(input.snapshot.candidates[0], { secret: 'raw' })
      },
      (input) => {
        Object.assign(input.snapshot.candidates[0].samples[0], {
          rawHeaders: {},
        })
      },
      (input) => {
        input.snapshot.candidates = Array.from({ length: 101 }, () =>
          structuredClone(input.snapshot.candidates[0]),
        )
      },
      (input) => {
        input.snapshot.candidates[0].samples = Array.from({ length: 4 }, () =>
          structuredClone(input.snapshot.candidates[0].samples[0]),
        )
      },
      (input) => {
        input.snapshot.candidates[0].samples[0].response = 'x'.repeat(65537)
      },
      (input) => {
        input.snapshot.candidates[0].samples[0].response = {
          token: 'raw-secret',
        }
      },
      (input) => {
        input.snapshot.candidates[0].samples[0].request.url =
          'https://api.example/balance?token=raw-secret'
      },
      (input) => {
        input.snapshot.candidates[0].samples[0].triggerPath =
          '/app?token=raw-secret'
      },
      (input) => {
        input.snapshot.quota.bytes = 5242881
      },
    ]
    for (const mutate of mutations) {
      const input = valid()
      mutate(input)
      expect(parseDiscoveryResponse(input, request)).toBeNull()
    }
  })
  it('accepts encoded safe triggers without rewriting their query bytes', () => {
    const input = valid()
    input.snapshot.candidates[0].samples[0].triggerPath = '/app?q=a%20b&q=c%2Fd'
    expect(parseDiscoveryResponse(input, request)).toEqual(input)
  })
  it('preserves the native body nesting budget inside the response envelope', () => {
    const input = valid()
    let body: import('../zktls/discovery/redaction').Json = 42
    for (let i = 0; i < 30; i++) body = { child: body }
    input.snapshot.candidates[0].samples[0].response = body
    expect(parseDiscoveryResponse(input, request)).toEqual(input)
  })
  it('rejects accessors, nested proxies, hidden keys and exotic prototypes without getters', () => {
    const getter = vi.fn(() => 'raw')
    const accessor = valid()
    Object.defineProperty(
      accessor.snapshot.candidates[0].samples[0],
      'response',
      { enumerable: true, get: getter },
    )
    const proxy = valid()
    proxy.snapshot.candidates[0].samples[0].response = new Proxy({}, {})
    const hidden = Object.defineProperty(valid(), 'raw', { value: 'secret' })
    for (const input of [
      accessor,
      proxy,
      hidden,
      new Proxy(valid(), {}),
      Object.setPrototypeOf(valid(), { raw: 'secret' }),
    ])
      expect(parseDiscoveryResponse(input, request)).toBeNull()
    expect(getter).not.toHaveBeenCalled()
  })
})
