import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { maybeAttachWatermark } from '../watermark'

const mocks = vi.hoisted(() => ({
  localGet: vi.fn(),
}))

vi.mock('../env', () => ({
  API_ENDPOINT: 'https://api.example/graphql',
}))

vi.mock('../storage', () => ({
  localStore: {
    get: mocks.localGet,
  },
}))

const VERIFY_QUERY = `
  mutation VerifyEngagement($campaignId: ID!) {
    verifyEngagement(campaignId: $campaignId) {
      success
    }
  }
`

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

describe('watermark cancellation', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.localGet.mockResolvedValue('lhdao_pk_test')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('propagates caller abort to a pending watermark mint', async () => {
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal
        const rejectAsAborted = () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }
        if (signal?.aborted) rejectAsAborted()
        else signal?.addEventListener('abort', rejectAsAborted, { once: true })
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    const headers = { 'x-device-id': 'device-watermark-test' }

    const request = maybeAttachWatermark(headers, VERIFY_QUERY, caller.signal)
    const outcome = observeBefore(request, 1)

    await vi.advanceTimersByTimeAsync(0)
    const mintSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)
      ?.signal
    expect(mintSignal).toBeInstanceOf(AbortSignal)
    caller.abort()
    await vi.advanceTimersByTimeAsync(1)

    expect(await outcome).toMatchObject({ status: 'rejected' })
    expect(mintSignal?.aborted).toBe(true)
    expect(headers).not.toHaveProperty('x-wm-status')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps caller abort attached while the mint response body is pending', async () => {
    const body = new Promise<unknown>(() => undefined)
    const response = {
      ok: true,
      status: 200,
      json: vi.fn(() => body),
    } as unknown as Response
    const fetchMock = vi.fn().mockResolvedValue(response)
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    const headers = { 'x-device-id': 'device-watermark-body-test' }

    const request = maybeAttachWatermark(headers, VERIFY_QUERY, caller.signal)
    const outcome = observeBefore(request, 1)

    await vi.advanceTimersByTimeAsync(0)
    expect(response.json).toHaveBeenCalledTimes(1)
    const mintSignal = (fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)
      ?.signal
    expect(mintSignal).toBeInstanceOf(AbortSignal)
    caller.abort()
    await vi.advanceTimersByTimeAsync(1)

    expect(await outcome).toMatchObject({ status: 'rejected' })
    expect(mintSignal?.aborted).toBe(true)
    expect(headers).not.toHaveProperty('x-wm-status')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not start mint fetch after abort during token storage read', async () => {
    let resolveToken: ((token: string) => void) | undefined
    mocks.localGet.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveToken = resolve
      }),
    )
    const fetchMock = vi
      .fn()
      .mockRejectedValue(
        new DOMException('The operation was aborted', 'AbortError'),
      )
    vi.stubGlobal('fetch', fetchMock)
    const caller = new AbortController()
    const headers = { 'x-device-id': 'device-watermark-storage-test' }

    const request = maybeAttachWatermark(headers, VERIFY_QUERY, caller.signal)
    const settled = request.then(
      () => ({ status: 'fulfilled' as const }),
      (reason: unknown) => ({ status: 'rejected' as const, reason }),
    )
    const promptOutcome = Promise.race([
      settled,
      new Promise<{ status: 'pending' }>((resolve) => {
        setTimeout(() => resolve({ status: 'pending' }), 1)
      }),
    ])

    await vi.advanceTimersByTimeAsync(0)
    caller.abort()
    await vi.advanceTimersByTimeAsync(1)
    const promptResult = await promptOutcome
    resolveToken?.('lhdao_pk_test')
    await vi.advanceTimersByTimeAsync(0)
    await settled

    expect(promptResult).toMatchObject({ status: 'rejected' })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(headers).not.toHaveProperty('x-wm-status')
    expect(vi.getTimerCount()).toBe(0)
  })
})
