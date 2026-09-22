import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureLegacyDeviceRegistered,
  registerLegacyPluginDevice,
} from '../device-registration'

const mocks = vi.hoisted(() => ({
  localGet: vi.fn(),
  localSet: vi.fn(),
}))

vi.mock('../env', () => ({ API_ENDPOINT: 'https://example.test/graphql' }))
vi.mock('../storage', () => ({
  localStore: {
    get: mocks.localGet,
    set: mocks.localSet,
  },
}))

describe('legacy device registration bridge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('uses the bearer token without request-signature headers', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { registerPluginDevice: true } }), {
        status: 200,
      }),
    )

    await registerLegacyPluginDevice(
      'lhdao_pk_existing',
      {
        deviceId: 'device-test-1',
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
      fetcher,
      controller.signal,
    )

    const init = fetcher.mock.calls[0][1] as RequestInit
    expect(init.signal).toBe(controller.signal)
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer lhdao_pk_existing',
      'x-device-id': 'device-test-1',
    })
    expect(init.headers).not.toHaveProperty('x-plugin-operation-id')
    expect(init.headers).not.toHaveProperty('x-device-signature')
    expect(JSON.parse(init.body as string)).toMatchObject({
      variables: {
        deviceId: 'device-test-1',
        publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
      },
    })
  })

  it('does not let one caller abort another registration', async () => {
    mocks.localGet.mockResolvedValue(undefined)
    mocks.localSet.mockResolvedValue(undefined)
    const completions = new Map<AbortSignal, () => void>()
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((resolve, reject) => {
        const signal = init?.signal
        if (!signal) {
          reject(new Error('registration fetch did not receive a signal'))
          return
        }
        const abort = () =>
          reject(new DOMException('The operation was aborted', 'AbortError'))
        if (signal.aborted) abort()
        else signal.addEventListener('abort', abort, { once: true })
        completions.set(signal, () =>
          resolve(
            new Response(
              JSON.stringify({ data: { registerPluginDevice: true } }),
              { status: 200 },
            ),
          ),
        )
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const identity = {
      deviceId: 'device-concurrent-test',
      publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' },
    }
    const firstCaller = new AbortController()
    const secondCaller = new AbortController()

    const first = ensureLegacyDeviceRegistered(
      'lhdao_pk_concurrent',
      identity,
      firstCaller.signal,
    )
    const firstOutcome = first.then(
      () => 'fulfilled',
      () => 'rejected',
    )
    const second = ensureLegacyDeviceRegistered(
      'lhdao_pk_concurrent',
      identity,
      secondCaller.signal,
    )

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    firstCaller.abort()
    const completeSecond = completions.get(secondCaller.signal)
    expect(completeSecond).toBeTypeOf('function')
    completeSecond?.()

    await expect(firstOutcome).resolves.toBe('rejected')
    await expect(second).resolves.toBeUndefined()
    expect(secondCaller.signal.aborted).toBe(false)
  })
})
