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
                tweetId: '123',
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

it.each([
  ['LIKE'],
  ['RT'],
  ['COMMENT'],
  ['FOLLOW'],
  ['COMMENT_LIKE'],
  ['COMMENT', 'RT', 'FOLLOW'],
  ['COMMENT_LIKE', 'RT', 'FOLLOW'],
])('preserves accepted task actions %j without inventing LIKE', async (...actions) => {
  const { lighthouse3Operation } = await import('../lighthouse3-transport')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              scope: 'OWN_RESERVED_ENGAGEMENT',
              me: { id: 'user-1' },
              tasks: [
                {
                  id: 'campaign-1',
                  acceptedReceiptId: 'receipt-1',
                  tweetId: '123',
                  targetUsername: '@Alice',
                  acceptedRewardLux: '12',
                  penaltyDivisor: '2',
                  actions: actions.map((actionType) => ({
                    actionType,
                    baseReward: 2,
                    targetCount: 1,
                  })),
                },
              ],
            },
          }),
        ),
    ),
  )
  const result = (await lighthouse3Operation(
    endpoint,
    'MyReservedEngagements',
    {},
  )) as {
    myReservedEngagements: {
      actions: { actionType: string }[]
      myExpectedReward: number
      targetUsername: string
    }[]
  }
  expect(
    result.myReservedEngagements[0].actions.map((a) => a.actionType),
  ).toEqual(actions)
  expect(result.myReservedEngagements[0].myExpectedReward).toBe(6)
  expect(result.myReservedEngagements[0].targetUsername).toBe('alice')
})

it.each([
  [],
  [{ actionType: 'UNKNOWN' }],
  [{ actionType: 'LIKE' }, { actionType: 'LIKE' }],
])('rejects malformed action requirements instead of silently assigning LIKE: %j', async (...actions) => {
  const { lighthouse3Operation } = await import('../lighthouse3-transport')
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              scope: 'OWN_RESERVED_ENGAGEMENT',
              me: {},
              tasks: [
                {
                  id: 'campaign-1',
                  acceptedReceiptId: 'receipt-1',
                  tweetId: '123',
                  targetUsername: '@Alice',
                  acceptedRewardLux: '1',
                  penaltyDivisor: '1',
                  actions,
                },
              ],
            },
          }),
        ),
    ),
  )
  await expect(
    lighthouse3Operation(endpoint, 'MyReservedEngagements', {}),
  ).rejects.toThrow('LH3_RESPONSE_INVALID')
})

it.each([
  'RT',
  'COMMENT',
  'COMMENT_LIKE',
  'FOLLOW',
])('submits original %s proof through its persisted engagement receipt and retries identically', async (actionType) => {
  const { lighthouse3Operation } = await import('../lighthouse3-transport')
  const values: Record<string, unknown> = {}
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: values[key] })),
        set: vi.fn(async (next: Record<string, unknown>) =>
          Object.assign(values, next),
        ),
        remove: vi.fn(async (key: string) => {
          delete values[key]
        }),
      },
    },
  })
  let submitCount = 0
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/received-tasks'))
        return new Response(
          JSON.stringify({
            data: {
              scope: 'OWN_RESERVED_ENGAGEMENT',
              me: {},
              tasks: [
                {
                  id: 'campaign-1',
                  acceptedReceiptId: 'receipt-1',
                  tweetId: '123',
                  targetUsername: '@Alice',
                  acceptedRewardLux: '1',
                  penaltyDivisor: '1',
                  actions: [{ actionType, baseReward: 1, targetCount: 1 }],
                },
              ],
            },
          }),
        )
      if (url.endsWith('/engagement-ticket'))
        return new Response(
          JSON.stringify({
            data: {
              ticket: 'ticket-1',
              macKey: 'mac-1',
              expiresAt: '2026-12-01T00:00:00.000Z',
            },
          }),
        )
      if (!url.endsWith('/engagement-verification'))
        throw Error('unexpected route: ' + url)
      const input = JSON.parse(String(init.body))
      sent.push(String(init.body))
      if (submitCount++ === 0) throw Error('connection lost')
      return new Response(
        JSON.stringify({
          data: {
            status: 'VERIFYING',
            requestKey: input.requestKey,
            campaignId: 'campaign-1',
            acceptedReceiptId: 'receipt-1',
            tweetId: '123',
          },
        }),
      )
    }),
  )
  await lighthouse3Operation(endpoint, 'MintEngagementTicket', {
    campaignId: 'campaign-1',
  })
  const proof = {
    campaignId: 'campaign-1',
    ticket: 'ticket-1',
    nonce: 'original',
    actions:
      actionType === 'FOLLOW'
        ? [{ actionType: 'FOLLOW', handle: ' @Alice ' }]
        : actionType === 'COMMENT_LIKE'
          ? [
              { actionType: 'COMMENT', tweetId: '123', resultTweetId: '456' },
              { actionType: 'LIKE', tweetId: '123' },
            ]
          : [{ actionType, tweetId: '123' }],
    commentText: 'original comment',
    sig: 'original-signature',
  }
  await expect(
    lighthouse3Operation(endpoint, 'SubmitEngagementProof', { input: proof }),
  ).rejects.toThrow('connection lost')
  expect(await resumeLighthouse3Proof(endpoint, 'campaign-1')).toBe(true)
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(sent[1])
  expect(JSON.parse(sent[0]).proof).toEqual(proof)
})

it('retains generic proof when acknowledgement names a foreign acceptance', async () => {
  const remove = vi.fn()
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: {
            family: 'engagement',
            receiptId: 'own-receipt',
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
              requestKey: 'original',
              campaignId: 'campaign-1',
              acceptedReceiptId: 'foreign-receipt',
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

function pendingStorage(family = 'engagement') {
  const pending = {
    family,
    receiptId: 'receipt-1',
    input: {
      requestKey: 'original',
      deviceId: 'device-123',
      proof: { campaignId: 'campaign-1' },
    },
  }
  let saved: unknown = pending
  const remove = vi.fn(async () => {
    saved = undefined
  })
  vi.stubGlobal('chrome', {
    storage: {
      local: { get: vi.fn(async (key: string) => ({ [key]: saved })), remove },
    },
  })
  return { pending, remove }
}

it.each([
  'ENGAGEMENT_PROOF_INVALID',
  'PROOF_COMMENT_INVALID',
  'COMMENT_TOO_SHORT',
])('clears definitely unadmitted %s so the next attempt can mint', async (code) => {
  const { remove } = pendingStorage()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ code }), { status: 422 })),
  )
  await expect(
    resumeLighthouse3Proof(endpoint, 'campaign-1'),
  ).rejects.toMatchObject({ code })
  expect(remove).toHaveBeenCalledTimes(1)
  expect(await resumeLighthouse3Proof(endpoint, 'campaign-1')).toBe(false)
})

it.each([
  ['COMMENT_TOO_SHORT', 500],
  ['COMMENT_TOO_SHORT', 401],
  ['TOKEN_UNKNOWN', 403],
  ['ENGAGEMENT_TICKET_REPLAY', 409],
  ['PROOF_TS_SKEW', 422],
  ['ENGAGEMENT_PROOF_SIGNATURE_INVALID', 422],
  ['UNKNOWN', 400],
  ['TOKEN_EXPIRED', 422],
])('preserves uncertain refusal %s/%s', async (code, status) => {
  const { remove } = pendingStorage()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ code }), { status })),
  )
  await expect(
    resumeLighthouse3Proof(endpoint, 'campaign-1'),
  ).rejects.toMatchObject({ code })
  expect(remove).not.toHaveBeenCalled()
})

it('serializes concurrent resumes so acknowledgement is consumed once', async () => {
  pendingStorage()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const fetcher = vi.fn(async () => {
    entered()
    await gate
    return new Response(
      JSON.stringify({
        data: {
          status: 'VERIFYING',
          requestKey: 'original',
          campaignId: 'campaign-1',
          acceptedReceiptId: 'receipt-1',
          tweetId: '123',
        },
      }),
    )
  })
  vi.stubGlobal('fetch', fetcher)
  const first = resumeLighthouse3Proof(endpoint, 'campaign-1')
  await started
  const second = resumeLighthouse3Proof(endpoint, 'campaign-1')
  release()
  expect(await Promise.all([first, second])).toEqual([true, false])
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('concurrent submissions preserve the first uncertain command rather than overwrite it', async () => {
  const { lighthouse3Operation } = await import('../lighthouse3-transport')
  const values: Record<string, unknown> = {}
  const writes: unknown[] = []
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: key.startsWith('lh3-ticket:')
            ? {
                receiptId: 'receipt-1',
                family: 'engagement',
                campaignId: 'campaign-1',
                requestKey: key,
              }
            : values[key],
        })),
        set: vi.fn(async (next: Record<string, unknown>) => {
          writes.push(next)
          Object.assign(values, next)
        }),
        remove: vi.fn(async (key: string) => {
          delete values[key]
        }),
      },
    },
  })
  const sent: string[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(String(init.body))
      throw new Error('unknown network outcome')
    }),
  )
  const outcomes = await Promise.allSettled(
    ['ticket-a', 'ticket-b'].map((ticket) =>
      lighthouse3Operation(endpoint, 'SubmitEngagementProof', {
        input: {
          campaignId: 'campaign-1',
          ticket,
          nonce: ticket,
          actions: [{ actionType: 'FOLLOW', handle: 'alice' }],
          sig: ticket,
        },
      }),
    ),
  )
  expect(outcomes.map((result) => result.status)).toEqual([
    'rejected',
    'rejected',
  ])
  expect(writes).toHaveLength(1)
  expect(sent).toHaveLength(2)
  expect(sent[0]).toBe(sent[1])
})

it.each([
  ['COMMENT_LIKE', [{ actionType: 'COMMENT', tweetId: '123' }]],
  ['COMMENT_LIKE', [{ actionType: 'LIKE', tweetId: '123' }]],
  ['COMMENT_LIKE', [{ actionType: 'COMMENT_LIKE', tweetId: '123' }]],
  ['FOLLOW', [{ actionType: 'FOLLOW', tweetId: '123' }]],
  ['FOLLOW', [{ actionType: 'FOLLOW', handle: 'wrong' }]],
  ['RT', [{ actionType: 'LIKE', tweetId: '123' }]],
  ['RT', [{ actionType: 'RT', tweetId: 'wrong' }]],
  [
    'COMMENT_LIKE',
    [
      { actionType: 'COMMENT', tweetId: '123' },
      { actionType: 'LIKE', tweetId: 'wrong' },
    ],
  ],
  [
    'COMMENT_LIKE',
    [
      { actionType: 'COMMENT', tweetId: 'wrong' },
      { actionType: 'LIKE', tweetId: '123' },
    ],
  ],
])('rejects incomplete %s proof before saving or sending it', async (actionType, actions) => {
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
  const fetcher = vi.fn(async (url: string) => {
    if (url.endsWith('/received-tasks'))
      return new Response(
        JSON.stringify({
          data: {
            scope: 'OWN_RESERVED_ENGAGEMENT',
            me: {},
            tasks: [
              {
                id: 'campaign-1',
                acceptedReceiptId: 'receipt-1',
                tweetId: '123',
                acceptedRewardLux: '1',
                penaltyDivisor: '1',
                targetUsername: ' @Alice ',
                actions: [{ actionType, baseReward: 1, targetCount: 1 }],
              },
            ],
          },
        }),
      )
    if (url.endsWith('/engagement-ticket'))
      return new Response(
        JSON.stringify({
          data: {
            ticket: 'ticket-1',
            macKey: 'mac',
            expiresAt: '2026-12-01T00:00:00Z',
          },
        }),
      )
    throw new Error('incomplete proof reached network')
  })
  vi.stubGlobal('fetch', fetcher)
  await lighthouse3Operation(endpoint, 'MintEngagementTicket', {
    campaignId: 'campaign-1',
  })
  await expect(
    lighthouse3Operation(endpoint, 'SubmitEngagementProof', {
      input: {
        campaignId: 'campaign-1',
        ticket: 'ticket-1',
        actions,
        commentText: 'original comment',
        sig: 'original',
      },
    }),
  ).rejects.toThrow('LH3_ACTIONS_INCOMPLETE')
  expect(
    Object.keys(values).some((key) => key.startsWith('lh3-pending:')),
  ).toBe(false)
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([
  'ENGAGEMENT_CAPTURE_REQUIRED',
  'PROOF_TS_SKEW',
  'ENGAGEMENT_TICKET_EXPIRED',
])('recovers generic pre-admission 409 %s but preserves LIKE pending', async (code) => {
  for (const family of ['engagement', 'like']) {
    const { remove } = pendingStorage(family)
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(JSON.stringify({ code }), { status: 409 }),
      ),
    )
    await expect(
      resumeLighthouse3Proof(endpoint, 'campaign-1'),
    ).rejects.toMatchObject({ code })
    if (family === 'engagement') {
      expect(remove).toHaveBeenCalledTimes(1)
      expect(await resumeLighthouse3Proof(endpoint, 'campaign-1')).toBe(false)
    } else expect(remove).not.toHaveBeenCalled()
  }
})
