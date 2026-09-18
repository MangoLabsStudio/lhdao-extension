import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sha256Hex } from '../canonical-json'
import { GqlError, gql } from '../gql'
import * as queries from '../queries'
import { buildPluginSignatureMessage } from '../request-signing'

const mocks = vi.hoisted(() => ({
  ensureLegacyDeviceRegistered: vi.fn(),
  getDeviceId: vi.fn(),
  getOrCreateDeviceIdentity: vi.fn(),
  localGet: vi.fn(),
  maybeAttachWatermark: vi.fn(),
}))

vi.mock('../env', () => ({
  API_ENDPOINT: 'https://api.example/graphql',
}))

vi.mock('../storage', () => ({
  localStore: {
    get: mocks.localGet,
  },
}))

vi.mock('../device-key', () => ({
  getOrCreateDeviceIdentity: mocks.getOrCreateDeviceIdentity,
}))

vi.mock('../device-registration', () => ({
  ensureLegacyDeviceRegistered: mocks.ensureLegacyDeviceRegistered,
}))

vi.mock('../watermark', () => ({
  getDeviceId: mocks.getDeviceId,
  maybeAttachWatermark: mocks.maybeAttachWatermark,
}))

const QUERY = `
  mutation RetryableMutation($input: String!) {
    retryableMutation(input: $input)
  }
`

function jsonResponse(
  payload: unknown,
  init: { status?: number } = {},
): Response {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
    status: init.status ?? 200,
  })
}

function abortablePendingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal
      if (!signal) {
        reject(new Error('fetch did not receive an AbortSignal'))
        return
      }

      const rejectAsAborted = () => {
        reject(new DOMException('The operation was aborted', 'AbortError'))
      }
      if (signal.aborted) rejectAsAborted()
      else signal.addEventListener('abort', rejectAsAborted, { once: true })
    })
  })
}

function requestSignal(fetchMock: ReturnType<typeof abortablePendingFetch>) {
  const init = fetchMock.mock.calls[0]?.[1]
  return init?.signal
}

function requestBody(fetchMock: ReturnType<typeof vi.fn>, callIndex: number) {
  const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit | undefined
  if (typeof init?.body !== 'string') throw new Error('missing request body')
  return JSON.parse(init.body) as Record<string, unknown>
}

type PromiseOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown }
  | { status: 'pending' }

function observeBefore<T>(
  promise: Promise<T>,
  delayMs: number,
): Promise<PromiseOutcome<T>> {
  return Promise.race([
    promise.then(
      (value): PromiseOutcome<T> => ({ status: 'fulfilled', value }),
      (reason): PromiseOutcome<T> => ({ status: 'rejected', reason }),
    ),
    new Promise<PromiseOutcome<T>>((resolve) => {
      setTimeout(() => resolve({ status: 'pending' }), delayMs)
    }),
  ])
}

describe('gql transport outcomes', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.localGet.mockResolvedValue('lhdao_pk_test')
    mocks.getDeviceId.mockResolvedValue('device-test')
    mocks.maybeAttachWatermark.mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('does not start storage work for an already-aborted request', async () => {
    const caller = new AbortController()
    caller.abort()
    mocks.localGet.mockRejectedValue(new Error('storage should not start'))

    await expect(
      gql(QUERY, { input: 'same-payload' }, { signal: caller.signal }),
    ).rejects.toMatchObject({
      kind: 'ABORT',
      uncertain: true,
      abortSource: 'CALLER',
    })

    expect(mocks.localGet).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a pre-fetch client validation failure definite', async () => {
    mocks.localGet.mockResolvedValue(null)

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'CLIENT',
      uncertain: false,
      httpStatus: undefined,
    })

    expect(vi.getTimerCount()).toBe(0)
  })

  it('merges a caller AbortSignal and reports an uncertain caller abort', async () => {
    const fetchMock = abortablePendingFetch()
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()

    const request = gql<{ retryableMutation: boolean }, { input: string }>(
      QUERY,
      { input: 'same-payload' },
      { signal: caller.signal },
    )
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'ABORT',
      uncertain: true,
      abortSource: 'CALLER',
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(requestSignal(fetchMock)).toBeInstanceOf(AbortSignal)
    expect(requestSignal(fetchMock)).not.toBe(caller.signal)
    caller.abort()

    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })

  it('uses a 15 second default timeout and reports an uncertain timeout abort', async () => {
    const fetchMock = abortablePendingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const request = gql<{ retryableMutation: boolean }, { input: string }>(
      QUERY,
      { input: 'same-payload' },
    )
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'ABORT',
      uncertain: true,
      abortSource: 'TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(14_999)
    expect(requestSignal(fetchMock)?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await rejection
    expect(requestSignal(fetchMock)?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('honors an explicit timeout and clears its timer', async () => {
    const fetchMock = abortablePendingFetch()
    vi.stubGlobal('fetch', fetchMock)

    const request = gql<{ retryableMutation: boolean }, { input: string }>(
      QUERY,
      { input: 'same-payload' },
      { timeoutMs: 25 },
    )
    const rejection = expect(request).rejects.toMatchObject({
      kind: 'ABORT',
      abortSource: 'TIMEOUT',
    })

    await vi.advanceTimersByTimeAsync(25)
    await rejection
    expect(mocks.maybeAttachWatermark.mock.calls[0]?.[2]).toBeInstanceOf(
      AbortSignal,
    )
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts while signed operation device identity is still pending', async () => {
    const caller = new AbortController()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mocks.getOrCreateDeviceIdentity.mockReturnValue(
      new Promise<void>(() => undefined),
    )

    const request = gql(
      queries.ME_QUERY,
      {},
      {
        operationName: 'Me',
        signal: caller.signal,
      },
    )
    const outcome = observeBefore(request, 1)

    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.getOrCreateDeviceIdentity).toHaveBeenCalledTimes(1)
    caller.abort()
    await vi.advanceTimersByTimeAsync(1)

    expect(await outcome).toMatchObject({
      status: 'rejected',
      reason: {
        kind: 'ABORT',
        uncertain: true,
        abortSource: 'CALLER',
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out while signed operation device identity is still pending', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    mocks.getOrCreateDeviceIdentity.mockReturnValue(
      new Promise<void>(() => undefined),
    )

    const request = gql(
      queries.ME_QUERY,
      {},
      {
        operationName: 'Me',
        timeoutMs: 25,
      },
    )
    const outcome = observeBefore(request, 26)

    await vi.advanceTimersByTimeAsync(26)

    expect(await outcome).toMatchObject({
      status: 'rejected',
      reason: {
        kind: 'ABORT',
        uncertain: true,
        abortSource: 'TIMEOUT',
      },
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a GraphQL error delivered with HTTP 4xx definite', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            errors: [
              {
                message: 'rule-set changed',
                extensions: { code: 'PRODUCT_CONFIG_VERSION_MISMATCH' },
              },
            ],
          },
          { status: 400 },
        ),
      ),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'GRAPHQL',
      uncertain: false,
      graphqlErrors: [
        {
          message: 'rule-set changed',
          extensions: { code: 'PRODUCT_CONFIG_VERSION_MISMATCH' },
        },
      ],
      httpStatus: 400,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a stable GraphQL business error delivered with HTTP 200 definite', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          errors: [
            {
              message: 'rule-set changed',
              extensions: { code: 'PRODUCT_CONFIG_VERSION_MISMATCH' },
            },
          ],
        }),
      ),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'GRAPHQL',
      uncertain: false,
      graphqlErrors: [
        {
          message: 'rule-set changed',
          extensions: { code: 'PRODUCT_CONFIG_VERSION_MISMATCH' },
        },
      ],
      httpStatus: 200,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks an internal GraphQL error delivered with HTTP 200 as uncertain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          errors: [
            {
              message: 'resolver failed after commit',
              extensions: { code: 'INTERNAL_SERVER_ERROR' },
            },
          ],
        }),
      ),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'GRAPHQL',
      uncertain: true,
      graphqlErrors: [
        {
          message: 'resolver failed after commit',
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
      httpStatus: 200,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks a GraphQL error delivered with HTTP 5xx as uncertain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse(
          {
            errors: [
              {
                message: 'upstream failed after commit',
                extensions: { code: 'INTERNAL_SERVER_ERROR' },
              },
            ],
          },
          { status: 500 },
        ),
      ),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'GRAPHQL',
      uncertain: true,
      graphqlErrors: [
        {
          message: 'upstream failed after commit',
          extensions: { code: 'INTERNAL_SERVER_ERROR' },
        },
      ],
      httpStatus: 500,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps a definite 4xx HTTP error separate from transport uncertainty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('bad request', { status: 400 })),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'HTTP',
      uncertain: false,
      graphqlErrors: undefined,
      httpStatus: 400,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks a 5xx gateway response as an uncertain transport outcome', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('upstream unavailable', { status: 503 }),
        ),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'HTTP',
      uncertain: true,
      graphqlErrors: undefined,
      httpStatus: 503,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks a network failure as uncertain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new TypeError('connection reset')),
    )

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'NETWORK',
      uncertain: true,
      graphqlErrors: undefined,
      httpStatus: undefined,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    ['an empty body', () => new Response('', { status: 200 })],
    [
      'malformed JSON',
      () => new Response('<html>bad gateway</html>', { status: 200 }),
    ],
    ['missing data', () => jsonResponse({})],
  ])('marks a mutation with %s and HTTP 2xx as uncertain', async (_label, response) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response()))

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toMatchObject({
      kind: 'PROTOCOL',
      uncertain: true,
      graphqlErrors: undefined,
      httpStatus: 200,
    })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can retry the same variables after uncertainty and then succeed', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        jsonResponse({ data: { retryableMutation: true } }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const variables = { input: 'same-signed-payload' }
    const options = {
      operationName: 'RetryableMutation',
      timeoutMs: 1_000,
    }

    await expect(gql(QUERY, variables, options)).rejects.toMatchObject({
      kind: 'NETWORK',
      uncertain: true,
    })
    await expect(gql(QUERY, variables, options)).resolves.toEqual({
      retryableMutation: true,
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(requestBody(fetchMock, 0)).toEqual({
      operationName: 'RetryableMutation',
      query: QUERY,
      variables,
    })
    expect(requestBody(fetchMock, 1)).toEqual(requestBody(fetchMock, 0))
    expect(vi.getTimerCount()).toBe(0)
  })

  it('signs sync read operations without legacy device registration preflight', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    mocks.getOrCreateDeviceIdentity.mockResolvedValue({
      deviceId: 'device-sync-test',
      privateKey: pair.privateKey,
      publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    })
    mocks.getDeviceId.mockResolvedValue('device-sync-test')

    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { ok: true } })),
      )
    vi.stubGlobal('fetch', fetchMock)

    const operations = [
      {
        id: 'engagement.available.v5',
        name: 'AvailableEngagements',
        document: queries.AVAILABLE_ENGAGEMENTS_QUERY,
      },
      {
        id: 'engagement.reserved.v4',
        name: 'MyReservedEngagements',
        document: queries.MY_RESERVED_ENGAGEMENTS_QUERY,
      },
      {
        id: 'tweet.available.v2',
        name: 'AvailableTweets',
        document: queries.AVAILABLE_TWEETS_QUERY,
      },
      {
        id: 'user.me.v2',
        name: 'Me',
        document: queries.ME_QUERY,
      },
    ] as const

    for (const operation of operations) {
      await gql(operation.document)
    }

    expect(mocks.ensureLegacyDeviceRegistered).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(operations.length)
    for (const [index, operation] of operations.entries()) {
      const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
      const headers = new Headers(init?.headers)
      expect(headers.get('x-plugin-operation-id')).toBe(operation.id)
      const expectedMessage = buildPluginSignatureMessage({
        operationId: operation.id,
        documentSha256: await sha256Hex(operation.document),
        variablesSha256: await sha256Hex('{}'),
        deviceId: 'device-sync-test',
        timestamp: headers.get('x-request-timestamp')!,
        nonce: headers.get('x-request-nonce')!,
      })
      const signature = Uint8Array.from(
        atob(
          headers
            .get('x-device-signature')!
            .replace(/-/g, '+')
            .replace(/_/g, '/'),
        ),
        (c) => c.charCodeAt(0),
      )
      await expect(
        crypto.subtle.verify(
          { name: 'ECDSA', hash: 'SHA-256' },
          pair.publicKey,
          signature,
          new TextEncoder().encode(expectedMessage),
        ),
      ).resolves.toBe(true)
      expect(headers.get('x-device-id')).toBe('device-sync-test')
      expect(headers.get('x-request-timestamp')).toMatch(/^\d+$/)
      expect(headers.get('x-request-nonce')).toBeTruthy()
      expect(headers.get('x-device-signature')).toBeTruthy()
      expect(requestBody(fetchMock, index)).toMatchObject({
        query: operation.document,
      })
    }
  })

  it('keeps existing anonymous calls compatible', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ data: { retryableMutation: true } }))
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      gql(QUERY, { input: 'anonymous' }, { anonymous: true }),
    ).resolves.toEqual({ retryableMutation: true })

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined
    expect(new Headers(init?.headers).has('Authorization')).toBe(false)
    expect(mocks.getDeviceId).not.toHaveBeenCalled()
  })

  it('continues to expose GqlError for existing instanceof callers', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')))

    await expect(gql(QUERY, { input: 'same-payload' })).rejects.toBeInstanceOf(
      GqlError,
    )
  })
})
