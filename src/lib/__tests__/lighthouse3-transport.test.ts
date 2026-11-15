import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isLighthouse3Endpoint,
  lighthouse3Pairing,
  lighthouse3Post,
  pairingPage,
  resumeLighthouse3Proof,
} from '../lighthouse3-transport'
vi.mock('../storage', () => ({
  localStore: { get: vi.fn(async () => 'must-not-be-sent') },
}))
vi.mock('../device-key', () => ({
  getOrCreateDeviceIdentity: vi.fn(async () => ({
    deviceId: 'device-123',
    privateKey: {},
  })),
}))
vi.mock('../request-signing', () => ({
  signPluginRequest: vi.fn(async () => ({
    headers: { 'x-signature': 'signed' },
  })),
}))
afterEach(() => vi.unstubAllGlobals())
const endpoint = 'https://app.lhdaobeta.top/lighthouse3.0/api/v3'
describe('legacy plugin v3 connection', () => {
  it('only opts in the exact new beta endpoint', () => {
    expect(isLighthouse3Endpoint(endpoint)).toBe(true)
    for (const value of [
      'https://service.lhdaobeta.top/graphql',
      endpoint + '/',
      endpoint.replace('app.', 'evil.'),
      endpoint + '?x=1',
    ])
      expect(isLighthouse3Endpoint(value)).toBe(false)
  })
  it('keeps old pairing URL and uses fragment for new authorization', () => {
    expect(pairingPage('https://app.lhdao.top', 'abc', false)).toBe(
      'https://app.lhdao.top/extension/connect?code=abc',
    )
    expect(
      pairingPage('https://app.lhdaobeta.top/lighthouse3.0', 'abc', true),
    ).toBe('https://app.lhdaobeta.top/lighthouse3.0/extension/connect#code=abc')
  })
  it('anonymous pairing never sends stored tokens or cookies and never follows redirects', async () => {
    const fetcher = vi.fn(
      async () => new Response(JSON.stringify({ data: true })),
    )
    vi.stubGlobal('fetch', fetcher)
    const input = {
      code: 'a'.repeat(32),
      deviceId: 'device-123',
      publicKeyJwk: { kty: 'EC' },
    }
    expect(
      await lighthouse3Pairing(endpoint, 'CreateExtensionPairing', input),
    ).toEqual({ createExtensionPairing: true })
    expect(fetcher).toHaveBeenCalledWith(
      endpoint + '/plugin/pairings',
      expect.objectContaining({
        credentials: 'omit',
        redirect: 'error',
        body: JSON.stringify(input),
        headers: { 'content-type': 'application/json' },
      }),
    )
  })
  it('keeps pending/ready responses and propagates deployment rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ code: 'LOCAL_RUNTIME_WRITE_SCOPE' }), {
            status: 403,
          }),
      ),
    )
    await expect(
      lighthouse3Pairing(endpoint, 'CreateExtensionPairing', {}),
    ).rejects.toMatchObject({
      code: 'LOCAL_RUNTIME_WRITE_SCOPE',
      httpStatus: 403,
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ data: { status: 'PENDING' } })),
      ),
    )
    expect(
      await lighthouse3Pairing(endpoint, 'PollExtensionPairing', { code: 'a' }),
    ).toEqual({ pollExtensionPairing: { status: 'PENDING' } })
  })
  it('denies unauthenticated task commands and unsupported operations', async () => {
    await expect(lighthouse3Post(endpoint, 'plugin/tasks', {})).rejects.toThrow(
      'PLUGIN_SECURITY_REQUIRED',
    )
    await expect(
      lighthouse3Pairing(endpoint, 'SubmitEngagementProof', {}),
    ).rejects.toThrow('LH3_OPERATION_NOT_CONNECTED')
  })
})

it('retries an uncertain submission with the identical persisted command', async () => {
  const input = {
    requestKey: 'request-original',
    deviceId: 'device-123',
    proof: { campaignId: 'campaign-1', nonce: 'original-nonce' },
  }
  const pending = { receiptId: 'receipt-1', input }
  const remove = vi.fn()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: pending })),
        remove,
      },
    },
  })
  const fetcher = vi
    .fn()
    .mockRejectedValueOnce(new Error('connection lost'))
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: {
            status: 'VERIFYING',
            requestKey: 'request-original',
            campaignId: 'campaign-1',
          },
        }),
      ),
    )
  vi.stubGlobal('fetch', fetcher)
  await expect(resumeLighthouse3Proof(endpoint, 'campaign-1')).rejects.toThrow(
    'connection lost',
  )
  expect(remove).not.toHaveBeenCalled()
  expect(await resumeLighthouse3Proof(endpoint, 'campaign-1')).toBe(true)
  expect(fetcher.mock.calls.map((call) => call[1].body)).toEqual([
    JSON.stringify(input),
    JSON.stringify(input),
  ])
  expect(remove).toHaveBeenCalledTimes(1)
})
it('keeps the journal when the server acknowledges a different command', async () => {
  const remove = vi.fn()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: {
            receiptId: 'receipt-1',
            input: {
              requestKey: 'original',
              deviceId: 'device-123',
              proof: { campaignId: 'campaign-1' },
            },
          },
        })),
        remove,
      },
    },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              status: 'VERIFYING',
              requestKey: 'different',
              campaignId: 'campaign-1',
            },
          }),
        ),
    ),
  )
  await expect(resumeLighthouse3Proof(endpoint, 'campaign-1')).rejects.toThrow(
    'LH3_RECEIPT_MISMATCH',
  )
  expect(remove).not.toHaveBeenCalled()
})

it('binds the legacy ticket and proof to the accepted receipt without inventing captured actions', async () => {
  const { lighthouse3Operation } = await import('../lighthouse3-transport')
  const values: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) => {
          Object.assign(values, next)
        }),
        remove: vi.fn(async (key: string) => {
          delete values[key]
        }),
      },
    },
  })
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    const input = JSON.parse(String(init.body))
    if (url.endsWith('/received-tasks'))
      return new Response(
        JSON.stringify({
          data: {
            scope: 'OWN_RESERVED_LIKE',
            me: { id: 'user-1' },
            tasks: [
              {
                id: 'campaign-1',
                acceptedReceiptId: 'receipt-1',
                acceptedRewardLux: '10',
                penaltyDivisor: '2',
              },
            ],
          },
        }),
      )
    if (url.endsWith('/like-ticket'))
      return new Response(
        JSON.stringify({
          data: {
            ticket: 'ticket-1',
            macKey: 'mac-key',
            expiresAt: '2026-12-01T00:00:00.000Z',
          },
        }),
      )
    return new Response(
      JSON.stringify({
        data: {
          status: 'VERIFYING',
          requestKey: input.requestKey,
          campaignId: input.proof.campaignId,
        },
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  const synced = (await lighthouse3Operation(
    endpoint,
    'MyReservedEngagements',
    {},
  )) as { myReservedEngagements: { myExpectedReward: number }[] }
  expect(synced.myReservedEngagements[0].myExpectedReward).toBe(5)
  await lighthouse3Operation(endpoint, 'MintEngagementTicket', {
    campaignId: 'campaign-1',
  })
  const proof = {
    campaignId: 'campaign-1',
    ticket: 'ticket-1',
    nonce: 'nonce-original',
    ts: 1,
    sig: 'signature-original',
    actions: [
      {
        actionType: 'LIKE',
        tweetId: '123',
        capturedAt: '2026-11-16T00:00:00.000Z',
      },
    ],
  }
  expect(
    await lighthouse3Operation(endpoint, 'SubmitEngagementProof', {
      input: proof,
    }),
  ).toEqual({ submitEngagementProof: { accepted: true, status: 'VERIFYING' } })
  const sent = fetcher.mock.calls.find((call) =>
    call[0].endsWith('/like-verification'),
  )!
  expect(sent[0]).toBe(
    endpoint + '/dispatch/acceptances/receipt-1/like-verification',
  )
  expect(JSON.parse(String(sent[1].body)).proof).toEqual(proof)
})
