import { describe, expect, it } from 'vitest'
import { CandidateStore } from '../zktls/discovery/candidate-store'
import { parseDiscoveryResponse } from '../zktls/discovery/response-contract'

describe('discovery original type metadata', () => {
  it.each([
    ['string', '0x1111111111111111111111111111111111111111'],
    ['number', 42],
    ['object', { privateCanaryKey: 'secret-canary' }],
    ['array', ['secret-canary']],
    ['null', null],
  ])('retains only the original %s type at a masked wallet', (type, wallet) => {
    const store = new CandidateStore()
    expect(
      store.add({
        method: 'POST',
        url: 'https://api.example/account',
        documentUrl: 'https://client.example/account',
        requestHeaders: { 'content-type': 'application/json' },
        requestBody: JSON.stringify({ account: wallet }),
        contentType: 'application/json',
        responseBody: JSON.stringify({ wallet }),
      }),
    ).toBe('added')
    const snapshot = store.snapshot()
    const candidate = snapshot.candidates[0]
    expect(candidate.samples[0].response).toEqual({ wallet: '[REDACTED]' })
    expect(candidate.inference.responseShape).toEqual({
      response: 'object',
      'response.wallet': type,
    })
    expect(candidate.inference.requestShape['request.account']).toBe(type)
    expect(JSON.stringify(snapshot)).not.toMatch(
      /privateCanaryKey|secret-canary|0x111111/,
    )
    const response = {
      type: 'discovery-result',
      requestType: 'start-discovery',
      correlationId: 'types-test',
      ok: true,
      snapshot: {
        schema: 1,
        sessionId: 'types-session',
        pageOrigin: 'https://client.example',
        status: 'ready',
        reason: null,
        startedAt: 0,
        expiresAt: 900000,
        ...snapshot,
      },
    }
    expect(
      parseDiscoveryResponse(response, {
        type: 'start-discovery',
        correlationId: 'types-test',
        targetUrl: 'https://client.example/account',
      }),
    ).toEqual(response)
  })
})
