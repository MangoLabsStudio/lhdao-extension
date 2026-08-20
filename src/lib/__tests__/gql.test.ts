import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GqlError, gql } from '../gql'
import type {
  MintProductExperienceTestTicketVariables,
  MintProductExperienceTicketVariables,
  SubmitProductExperienceProofVariables,
} from '../queries'
import * as productQueries from '../queries'

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

const queryExports: Record<string, unknown> = productQueries

function requireQueryExport<T>(name: string, type: 'function' | 'string'): T {
  const value = queryExports[name]
  expect(value, `missing queries.ts export: ${name}`).toBeTypeOf(type)
  if (typeof value !== type)
    throw new Error(`missing queries.ts export: ${name}`)
  return value as T
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
      productQueries.PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
      { campaignId: 'campaign-product-001' },
      {
        operationName: productQueries.MintProductExperienceTicketOperationName,
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
      productQueries.PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
      { campaignId: 'campaign-product-001' },
      {
        operationName: productQueries.MintProductExperienceTicketOperationName,
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
        id: 'engagement.available.v2',
        name: 'AvailableEngagements',
        document: productQueries.AVAILABLE_ENGAGEMENTS_QUERY,
      },
      {
        id: 'engagement.reserved.v2',
        name: 'MyReservedEngagements',
        document: productQueries.MY_RESERVED_ENGAGEMENTS_QUERY,
      },
      {
        id: 'tweet.available.v1',
        name: 'AvailableTweets',
        document: productQueries.AVAILABLE_TWEETS_QUERY,
      },
      {
        id: 'user.me.v1',
        name: 'Me',
        document: productQueries.ME_QUERY,
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
      expect(headers.get('x-device-id')).toBe('device-sync-test')
      expect(headers.get('x-request-timestamp')).toMatch(/^\d+$/)
      expect(headers.get('x-request-nonce')).toBeTruthy()
      expect(headers.get('x-device-signature')).toBeTruthy()
      expect(requestBody(fetchMock, index)).toMatchObject({
        query: operation.document,
      })
    }
  })

  it('signs each operation in the shared product document', async () => {
    const pair = (await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign', 'verify'],
    )) as CryptoKeyPair
    mocks.getOrCreateDeviceIdentity.mockResolvedValue({
      deviceId: 'device-product-test',
      privateKey: pair.privateKey,
      publicKeyJwk: await crypto.subtle.exportKey('jwk', pair.publicKey),
    })
    mocks.getDeviceId.mockResolvedValue('device-product-test')
    mocks.ensureLegacyDeviceRegistered.mockResolvedValue(undefined)

    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ data: { accepted: true } })),
      )
    vi.stubGlobal('fetch', fetchMock)
    const operations = [
      {
        id: 'verify.product-experience.ticket.v1',
        name: productQueries.MintProductExperienceTicketOperationName,
        variables: { campaignId: 'campaign-product-001' },
      },
      {
        id: 'verify.product-experience.test-ticket.v1',
        name: productQueries.MintProductExperienceTestTicketOperationName,
        variables: { campaignId: 'campaign-product-001' },
      },
      {
        id: 'verify.product-experience.proof.v1',
        name: productQueries.SubmitProductExperienceProofOperationName,
        variables: { input: { campaignId: 'campaign-product-001' } },
      },
      {
        id: 'verify.product-experience.zktls-start.v1',
        name: productQueries.StartProductZkTlsProofOperationName,
        variables: {
          campaignId: 'campaign-product-001',
          ruleId: 'rule-a',
        },
      },
      {
        id: 'verify.product-experience.zktls-test-start.v1',
        name: productQueries.StartProductZkTlsTestProofOperationName,
        variables: {
          campaignId: 'campaign-product-001',
          ruleId: 'rule-a',
        },
      },
      {
        id: 'verify.product-experience.zktls-progress.v1',
        name: productQueries.ProductZkTlsRuleProgressOperationName,
        variables: { campaignId: 'campaign-product-001' },
      },
    ]

    for (const operation of operations) {
      await gql(
        productQueries.PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
        operation.variables,
        { operationName: operation.name },
      )
    }

    expect(fetchMock).toHaveBeenCalledTimes(6)
    for (const [index, operation] of operations.entries()) {
      const init = fetchMock.mock.calls[index]?.[1] as RequestInit | undefined
      const headers = new Headers(init?.headers)
      expect(headers.get('x-plugin-operation-id')).toBe(operation.id)
      expect(headers.get('x-device-id')).toBe('device-product-test')
      expect(headers.get('x-request-timestamp')).toMatch(/^\d+$/)
      expect(headers.get('x-request-nonce')).toBeTruthy()
      expect(headers.get('x-device-signature')).toBeTruthy()
      expect(requestBody(fetchMock, index)).toMatchObject({
        operationName: operation.name,
        query: productQueries.PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT,
        variables: operation.variables,
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

describe('product experience GraphQL document and response parsers', () => {
  const participantVariables = {
    campaignId: 'campaign-product-001',
  } satisfies MintProductExperienceTicketVariables
  const testVariables = {
    campaignId: 'campaign-product-001',
  } satisfies MintProductExperienceTestTicketVariables
  const proofVariables = {
    input: {
      version: 'product-experience-v1',
      campaignId: 'campaign-product-001',
      ticket: 'ticket-value',
      ruleSetVersion: 3,
      nonce: '00112233445566778899aabbccddeeff',
      ts: 1_783_936_800,
      ruleMatches: [
        {
          ruleId: 'rule-a',
          matchedAt: '2026-07-13T10:00:01.000Z',
          origin: 'https://client.example',
          urlPathHash: 'a'.repeat(64),
        },
      ],
      sig: 'proof-signature',
    },
  } satisfies SubmitProductExperienceProofVariables

  const ticketWire = {
    ticket: 'ticket-value',
    macKey: 'mac-key',
    expiresAt: '2026-07-13T10:30:00.000Z',
    ruleSetVersion: 3,
    allowedOrigins: ['https://client.example'],
    completionMode: 'ALL',
    verificationMode: 'ZKTLS',
    rules: [
      {
        id: 'exists',
        title: 'Exists',
        urlPattern: 'https://client.example/onboarding/*',
        selector: '[data-onboarding="done"]',
        condition: {
          type: 'ELEMENT_EXISTS',
          expected: null,
          attributeName: null,
          minimumCount: null,
          minimumValue: null,
        },
      },
      {
        id: 'text',
        title: 'Text',
        urlPattern: 'https://client.example/onboarding/*',
        selector: '[data-result]',
        condition: {
          type: 'TEXT_CONTAINS',
          expected: 'Complete',
          attributeName: null,
          minimumCount: null,
          minimumValue: null,
        },
      },
      {
        id: 'attribute',
        title: 'Attribute',
        urlPattern: 'https://client.example/onboarding/*',
        selector: '[data-state]',
        condition: {
          type: 'ATTRIBUTE_EQUALS',
          expected: 'done',
          attributeName: 'data-state',
          minimumCount: null,
          minimumValue: null,
        },
      },
      {
        id: 'count',
        title: 'Count',
        urlPattern: 'https://client.example/onboarding/*',
        selector: '[data-step="done"]',
        condition: {
          type: 'COUNT_AT_LEAST',
          expected: null,
          attributeName: null,
          minimumCount: 2,
          minimumValue: null,
        },
      },
      {
        id: 'volume',
        title: 'Volume',
        urlPattern: 'https://client.example/onboarding/*',
        selector: '#trading-volume',
        condition: {
          type: 'NUMERIC_AT_LEAST',
          expected: null,
          attributeName: null,
          minimumCount: null,
          minimumValue: 100000,
        },
      },
    ],
  }

  it('uses one raw .graphql document as the byte-identical runtime source', () => {
    const graphqlFile = resolve(
      process.cwd(),
      'src/graphql/product-experience.graphql',
    )
    expect(existsSync(graphqlFile)).toBe(true)
    if (!existsSync(graphqlFile)) throw new Error('missing GraphQL source file')

    const graphqlSource = readFileSync(graphqlFile, 'utf8')
    const queriesSource = readFileSync(
      resolve(process.cwd(), 'src/lib/queries.ts'),
      'utf8',
    )
    const document = requireQueryExport<string>(
      'PRODUCT_EXPERIENCE_GRAPHQL_DOCUMENT',
      'string',
    )

    expect(document).toBe(graphqlSource)
    expect(queriesSource).toContain(
      "import productExperienceGraphql from '../graphql/product-experience.graphql?raw'",
    )

    for (const [operationType, operationName] of [
      ['mutation', 'MintProductExperienceTicket'],
      ['mutation', 'MintProductExperienceTestTicket'],
      ['mutation', 'SubmitProductExperienceProof'],
      ['mutation', 'StartProductZkTlsProof'],
      ['mutation', 'StartProductZkTlsTestProof'],
      ['query', 'ProductZkTlsRuleProgress'],
    ]) {
      expect(
        graphqlSource.match(
          new RegExp(`${operationType} ${operationName}\\b`, 'g'),
        ),
      ).toHaveLength(1)
      expect(queriesSource).not.toMatch(
        new RegExp(`${operationType}\\s+${operationName}\\b`),
      )
      expect(queryExports[`${operationName}OperationName`]).toBe(operationName)
    }
  })

  it.each([
    [
      {
        type: 'ELEMENT_EXISTS',
        expected: null,
        attributeName: null,
        minimumCount: null,
        minimumValue: null,
      },
      { type: 'ELEMENT_EXISTS' },
    ],
    [
      {
        type: 'TEXT_CONTAINS',
        expected: 'Complete',
        attributeName: null,
        minimumCount: null,
        minimumValue: null,
      },
      { type: 'TEXT_CONTAINS', expected: 'Complete' },
    ],
    [
      {
        type: 'TEXT_CONTAINS',
        expected: '',
        attributeName: null,
        minimumCount: null,
        minimumValue: null,
      },
      { type: 'TEXT_CONTAINS', expected: '' },
    ],
    [
      {
        type: 'ATTRIBUTE_EQUALS',
        expected: 'done',
        attributeName: 'data-state',
        minimumCount: null,
        minimumValue: null,
      },
      {
        type: 'ATTRIBUTE_EQUALS',
        expected: 'done',
        attributeName: 'data-state',
      },
    ],
    [
      {
        type: 'COUNT_AT_LEAST',
        expected: null,
        attributeName: null,
        minimumCount: 2,
        minimumValue: null,
      },
      { type: 'COUNT_AT_LEAST', minimumCount: 2 },
    ],
    [
      {
        type: 'NUMERIC_AT_LEAST',
        expected: null,
        attributeName: null,
        minimumCount: null,
        minimumValue: 100000,
      },
      { type: 'NUMERIC_AT_LEAST', minimumValue: 100000 },
    ],
  ])('maps a valid wire condition into the discriminated union', (wire, parsed) => {
    const parseCondition = requireQueryExport<(value: unknown) => unknown>(
      'parseProductExperienceCondition',
      'function',
    )
    expect(parseCondition(wire)).toEqual(parsed)
  })

  it.each([
    {
      type: 'ELEMENT_EXISTS',
      expected: 'unexpected',
      attributeName: null,
      minimumCount: null,
      minimumValue: null,
    },
    {
      type: 'TEXT_CONTAINS',
      expected: null,
      attributeName: null,
      minimumCount: null,
      minimumValue: null,
    },
    {
      type: 'ATTRIBUTE_EQUALS',
      expected: 'done',
      attributeName: null,
      minimumCount: null,
      minimumValue: null,
    },
    {
      type: 'COUNT_AT_LEAST',
      expected: null,
      attributeName: null,
      minimumCount: 0,
      minimumValue: null,
    },
    {
      type: 'NUMERIC_AT_LEAST',
      expected: null,
      attributeName: null,
      minimumCount: null,
      minimumValue: 0,
    },
    {
      type: 'RUN_JAVASCRIPT',
      expected: 'alert(1)',
      attributeName: null,
      minimumCount: null,
      minimumValue: null,
    },
  ])('fails closed for an illegal wire condition combination', (wire) => {
    const parseCondition = requireQueryExport<(value: unknown) => unknown>(
      'parseProductExperienceCondition',
      'function',
    )
    expect(() => parseCondition(wire)).toThrow(
      'Invalid product experience GraphQL response',
    )
  })

  it('parses the participant ticket response without leaking nullable wire fields', () => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseMintProductExperienceTicketResult',
      'function',
    )

    expect(parseResult({ mintProductExperienceTicket: ticketWire })).toEqual({
      mintProductExperienceTicket: {
        ...ticketWire,
        rules: [
          { ...ticketWire.rules[0], condition: { type: 'ELEMENT_EXISTS' } },
          {
            ...ticketWire.rules[1],
            condition: { type: 'TEXT_CONTAINS', expected: 'Complete' },
          },
          {
            ...ticketWire.rules[2],
            condition: {
              type: 'ATTRIBUTE_EQUALS',
              attributeName: 'data-state',
              expected: 'done',
            },
          },
          {
            ...ticketWire.rules[3],
            condition: { type: 'COUNT_AT_LEAST', minimumCount: 2 },
          },
          {
            ...ticketWire.rules[4],
            condition: { type: 'NUMERIC_AT_LEAST', minimumValue: 100000 },
          },
        ],
      },
    })
    expect(participantVariables).toEqual({
      campaignId: 'campaign-product-001',
    })
  })

  it('parses the test ticket response through the same fail-closed ticket parser', () => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseMintProductExperienceTestTicketResult',
      'function',
    )

    const parsed = parseResult({ mintProductExperienceTestTicket: ticketWire })
    expect(parsed).toHaveProperty(
      'mintProductExperienceTestTicket.ticket',
      'ticket-value',
    )
    expect(parsed).toHaveProperty(
      'mintProductExperienceTestTicket.completionMode',
      'ALL',
    )
    expect(parsed).toHaveProperty(
      'mintProductExperienceTestTicket.rules.0.condition',
      { type: 'ELEMENT_EXISTS' },
    )
    expect(parsed).toHaveProperty(
      'mintProductExperienceTestTicket.rules.1.condition',
      { type: 'TEXT_CONTAINS', expected: 'Complete' },
    )
    expect(testVariables).toEqual({ campaignId: 'campaign-product-001' })
  })

  it.each([
    undefined,
    'UNKNOWN',
  ])('rejects a missing or unknown ticket verification mode', (verificationMode) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseMintProductExperienceTicketResult',
      'function',
    )
    const wire = { ...ticketWire, verificationMode }
    if (verificationMode === undefined) delete wire.verificationMode

    expect(() => parseResult({ mintProductExperienceTicket: wire })).toThrow(
      'Invalid product experience GraphQL response',
    )
  })

  it.each([
    'LEGACY_DOM',
    'ZKTLS',
  ])('accepts the %s ticket verification mode', (verificationMode) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseMintProductExperienceTicketResult',
      'function',
    )

    expect(
      parseResult({
        mintProductExperienceTicket: { ...ticketWire, verificationMode },
      }),
    ).toHaveProperty(
      'mintProductExperienceTicket.verificationMode',
      verificationMode,
    )
  })

  it.each([
    [
      'participant',
      'parseStartProductZkTlsProofResult',
      'startProductZkTlsProof',
    ],
    [
      'test',
      'parseStartProductZkTlsTestProofResult',
      'startProductZkTlsTestProof',
    ],
  ])('strictly parses a %s zkTLS proof session', (_kind, exportName, field) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      exportName,
      'function',
    )
    const session = {
      sessionId: 'session-001',
      connectorId: 'connector-001',
      expiresAt: '2026-07-13T10:30:00.000Z',
    }

    expect(parseResult({ [field]: session })).toEqual({ [field]: session })
  })

  it.each([
    [{ connectorId: 'connector-001', expiresAt: '2026-07-13T10:30:00.000Z' }],
    [
      {
        sessionId: 'session-001',
        connectorId: 'connector-001',
        expiresAt: '2026-07-13T10:30:00.000Z',
        claim: 'must-not-leak',
      },
    ],
    [
      {
        sessionId: '',
        connectorId: 'connector-001',
        expiresAt: '2026-07-13T10:30:00.000Z',
      },
    ],
    [
      {
        sessionId: 'session-001',
        connectorId: '',
        expiresAt: '2026-07-13T10:30:00.000Z',
      },
    ],
    [
      {
        sessionId: 'session-001',
        connectorId: 'connector-001',
        expiresAt: 'not-a-date',
      },
    ],
    [
      {
        sessionId: 'session-001',
        connectorId: 'connector-001',
        expiresAt: '2026-02-31T10:30:00.000Z',
      },
    ],
  ])('rejects a malformed zkTLS proof session %#', (session) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseStartProductZkTlsProofResult',
      'function',
    )

    expect(() => parseResult({ startProductZkTlsProof: session })).toThrow(
      'Invalid product experience GraphQL response',
    )
  })

  it.each([
    {},
    {
      startProductZkTlsProof: {
        sessionId: 'session-001',
        connectorId: 'connector-001',
        expiresAt: '2026-07-13T10:30:00.000Z',
      },
      campaign: {},
    },
  ])('rejects an invalid zkTLS proof response envelope %#', (response) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseStartProductZkTlsProofResult',
      'function',
    )

    expect(() => parseResult(response)).toThrow(
      'Invalid product experience GraphQL response',
    )
  })

  it('strictly parses zkTLS rule progress in stable wire order', () => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseProductZkTlsRuleProgressResult',
      'function',
    )
    const progress = [
      {
        ruleId: 'deposit',
        title: 'Deposit at least 100 USDT',
        status: 'VERIFIED',
        current: 120,
        target: 100,
        unit: 'USDT',
      },
      {
        ruleId: 'kyc',
        title: 'KYC complete',
        status: 'PENDING',
        current: false,
        target: true,
        unit: null,
      },
      {
        ruleId: 'tier',
        title: 'Tier name',
        status: 'PARTIAL',
        current: 'basic',
        target: 'pro',
        unit: null,
      },
      {
        ruleId: 'optional',
        title: 'Optional fact',
        status: 'SUBMITTED',
        current: null,
        target: null,
        unit: null,
      },
    ]

    expect(parseResult({ productZkTlsRuleProgress: progress })).toEqual({
      productZkTlsRuleProgress: progress,
    })
  })

  it.each([
    [
      'missing field',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: 0,
        target: 100,
      },
    ],
    [
      'extra field',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: 0,
        target: 100,
        unit: 'USDT',
        connectorId: 'must-not-leak',
      },
    ],
    [
      'empty rule id',
      {
        ruleId: '',
        title: 'Deposit',
        status: 'PENDING',
        current: 0,
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'empty title',
      {
        ruleId: 'deposit',
        title: '',
        status: 'PENDING',
        current: 0,
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'unknown status',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'FAILED',
        current: 0,
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'object current',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: {},
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'array target',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: 0,
        target: [],
        unit: 'USDT',
      },
    ],
    [
      'nonfinite current',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: Number.POSITIVE_INFINITY,
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'unsafe numeric magnitude',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: Number.MAX_VALUE,
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'empty scalar string',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: '',
        target: 100,
        unit: 'USDT',
      },
    ],
    [
      'invalid unit',
      {
        ruleId: 'deposit',
        title: 'Deposit',
        status: 'PENDING',
        current: 0,
        target: 100,
        unit: '',
      },
    ],
  ])('rejects progress with %s', (_label, item) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseProductZkTlsRuleProgressResult',
      'function',
    )

    expect(() => parseResult({ productZkTlsRuleProgress: [item] })).toThrow(
      'Invalid product experience GraphQL response',
    )
  })

  it.each([
    {},
    { productZkTlsRuleProgress: null },
    { productZkTlsRuleProgress: [], campaign: {} },
  ])('rejects an invalid zkTLS progress response envelope %#', (response) => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseProductZkTlsRuleProgressResult',
      'function',
    )

    expect(() => parseResult(response)).toThrow(
      'Invalid product experience GraphQL response',
    )
  })

  it('parses the proof response and rejects malformed response fields', () => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseSubmitProductExperienceProofResult',
      'function',
    )
    const response = {
      submitProductExperienceProof: {
        accepted: true,
        code: 'ACCEPTED',
        campaignId: 'campaign-product-001',
        configVersion: 3,
        verificationKind: 'EXPERIENCE',
        verifiedAt: '2026-07-13T10:00:03.000Z',
      },
    }

    expect(parseResult(response)).toEqual(response)
    expect(proofVariables.input.version).toBe('product-experience-v1')
    expect(() =>
      parseResult({
        submitProductExperienceProof: {
          ...response.submitProductExperienceProof,
          accepted: 'true',
        },
      }),
    ).toThrow('Invalid product experience GraphQL response')
  })

  it('fails closed when a ticket contains one malformed nested condition', () => {
    const parseResult = requireQueryExport<(value: unknown) => unknown>(
      'parseMintProductExperienceTicketResult',
      'function',
    )

    expect(() =>
      parseResult({
        mintProductExperienceTicket: {
          ...ticketWire,
          rules: [
            {
              ...ticketWire.rules[0],
              condition: {
                type: 'ELEMENT_EXISTS',
                expected: null,
                attributeName: null,
                minimumCount: 1,
                minimumValue: null,
              },
            },
          ],
        },
      }),
    ).toThrow('Invalid product experience GraphQL response')
  })
})
