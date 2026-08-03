import { afterEach, describe, expect, it, vi } from 'vitest'
import type { BinanceProbeObservation } from '@/lib/binance-square-probe'
import {
  installBinanceSquareBridge,
  probeObservationFromEvent,
} from '../binance-square-bridge.content'
import {
  installBinanceSquareProbe,
  isBinanceProbeCandidate,
} from '../binance-square-probe.content'

const target = { kind: 'CONTENT', id: '335389698745313' } as const

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function observation(
  overrides: Partial<BinanceProbeObservation> = {},
): BinanceProbeObservation {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    method: 'POST',
    path: '/bapi/example',
    status: 200,
    target,
    requestShape: { postId: '<target:CONTENT>' },
    responseShape: { code: '<digits:1>' },
    capturedAt: '2026-08-04T00:00:00.000Z',
    ...overrides,
  }
}

describe('Binance Square MAIN probe', () => {
  const originalFetch = window.fetch
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send

  afterEach(() => {
    installBinanceSquareProbe(false)
    vi.resetModules()
    window.fetch = originalFetch
    XMLHttpRequest.prototype.open = originalOpen
    XMLHttpRequest.prototype.send = originalSend
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it.each([
    ['GET', 'https://www.binance.com/bapi/example', false],
    ['POST', 'https://www.binance.com/bapi/example', true],
    ['post', '/bapi/example', true],
    ['POST', 'https://www.binance.com:444/bapi/example', false],
    ['POST', 'https://binance.com/bapi/example', false],
    ['POST', 'https://www.binance.com.evil/bapi/example', false],
    ['POST', 'https://www.binance.com/api/example', false],
    ['POST', 'https://www.binance.com/bapi', false],
  ])('validates %s %s', (method, url, expected) => {
    expect(
      isBinanceProbeCandidate(
        url,
        method,
        'https://www.binance.com/en/square/post/335389698745313',
      ),
    ).toBe(expected)
  })

  it('does not patch network APIs when beta capture is disabled', () => {
    const fetch = vi.fn()
    window.fetch = fetch

    installBinanceSquareProbe(false)

    expect(window.fetch).toBe(fetch)
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen)
    expect(XMLHttpRequest.prototype.send).toBe(originalSend)
  })

  it('deduplicates installs and restores only wrappers it still owns', async () => {
    const response = {
      status: 200,
      clone: () => ({ json: async () => ({ code: 0 }) }),
    } as Response
    const nativeFetch = vi.fn(async () => response) as typeof fetch
    window.fetch = nativeFetch
    const postMessage = vi.spyOn(window, 'postMessage')

    const releaseFirst = installBinanceSquareProbe(true)
    const ownedFetch = window.fetch
    const ownedOpen = XMLHttpRequest.prototype.open
    const ownedSend = XMLHttpRequest.prototype.send
    const releaseSecond = installBinanceSquareProbe(true)

    expect(window.fetch).toBe(ownedFetch)
    expect(XMLHttpRequest.prototype.open).toBe(ownedOpen)
    expect(XMLHttpRequest.prototype.send).toBe(ownedSend)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    await window.fetch('https://www.binance.com/bapi/example', {
      method: 'POST',
      body: JSON.stringify({ postId: target.id }),
    })
    await vi.waitFor(() => {
      expect(
        postMessage.mock.calls.filter(
          ([message]) =>
            (message as { __lhBinanceProbe?: unknown }).__lhBinanceProbe ===
            true,
        ),
      ).toHaveLength(1)
    })

    releaseFirst()
    expect(window.fetch).toBe(ownedFetch)
    releaseSecond()
    expect(window.fetch).toBe(nativeFetch)
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen)
    expect(XMLHttpRequest.prototype.send).toBe(originalSend)

    const replacementFetch = vi.fn(async () => response) as typeof fetch
    const replacementOpen =
      vi.fn() as unknown as typeof XMLHttpRequest.prototype.open
    const releaseOwned = installBinanceSquareProbe(true)
    window.fetch = replacementFetch
    XMLHttpRequest.prototype.open = replacementOpen
    releaseOwned()
    expect(window.fetch).toBe(replacementFetch)
    expect(XMLHttpRequest.prototype.open).toBe(replacementOpen)

    const releaseReinjected = installBinanceSquareProbe(true)
    expect(window.fetch).not.toBe(replacementFetch)
    expect(XMLHttpRequest.prototype.open).not.toBe(replacementOpen)
    releaseReinjected()
    expect(window.fetch).toBe(replacementFetch)
    expect(XMLHttpRequest.prototype.open).toBe(replacementOpen)
  })

  it('replaces an older bundle generation without stacking wrappers', async () => {
    const response = {
      status: 200,
      clone: () => ({ json: async () => ({ code: 0 }) }),
    } as Response
    const nativeFetch = vi.fn(async () => response) as typeof fetch
    window.fetch = nativeFetch
    const postMessage = vi.spyOn(window, 'postMessage')
    const releaseOld = installBinanceSquareProbe(true)
    const oldFetch = window.fetch

    vi.resetModules()
    const freshModule = await import('../binance-square-probe.content')
    const releaseFresh = freshModule.installBinanceSquareProbe(true)
    const freshFetch = window.fetch

    expect(freshFetch).not.toBe(oldFetch)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    await window.fetch('https://www.binance.com/bapi/example', {
      method: 'POST',
      body: JSON.stringify({ postId: target.id }),
    })
    await vi.waitFor(() => {
      expect(
        postMessage.mock.calls.filter(
          ([message]) =>
            (message as { __lhBinanceProbe?: unknown }).__lhBinanceProbe ===
            true,
        ),
      ).toHaveLength(1)
    })
    expect(nativeFetch).toHaveBeenCalledTimes(1)

    releaseOld()
    expect(window.fetch).toBe(freshFetch)
    releaseFresh()
    expect(window.fetch).toBe(nativeFetch)
    expect(XMLHttpRequest.prototype.open).toBe(originalOpen)
    expect(XMLHttpRequest.prototype.send).toBe(originalSend)
  })

  it('captures only configured targets and preserves the native fetch result', async () => {
    const response = {
      status: 200,
      clone: () => ({ json: async () => ({ code: 0 }) }),
    } as Response
    const nativeResult = Promise.resolve(response)
    window.fetch = vi.fn(() => nativeResult) as typeof fetch
    const postMessage = vi.spyOn(window, 'postMessage')
    installBinanceSquareProbe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )

    const returned = window.fetch('https://www.binance.com/bapi/example', {
      method: 'POST',
      body: JSON.stringify({ postId: target.id, text: 'private comment' }),
    })

    expect(returned).toBe(nativeResult)
    await returned
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          __lhBinanceProbe: true,
          observation: expect.objectContaining({
            method: 'POST',
            path: '/bapi/example',
            target,
            requestShape: {
              postId: '<target:CONTENT>',
              text: '<string:15>',
            },
          }),
        }),
        window.location.origin,
      )
    })

    postMessage.mockClear()
    await window.fetch('https://www.binance.com/bapi/example', {
      method: 'POST',
      body: JSON.stringify({ postId: '999999' }),
    })
    await Promise.resolve()
    expect(postMessage).not.toHaveBeenCalled()
  })

  it('preserves rejected and synchronously thrown fetch behavior', async () => {
    const rejected = Promise.reject(new Error('network'))
    window.fetch = vi.fn(() => rejected) as typeof fetch
    installBinanceSquareProbe(true)
    const returned = window.fetch('https://www.binance.com/bapi/example', {
      method: 'POST',
      body: '{}',
    })
    expect(returned).toBe(rejected)
    await expect(returned).rejects.toThrow('network')

    const thrown = new Error('sync')
    window.fetch = vi.fn(() => {
      throw thrown
    }) as typeof fetch
    installBinanceSquareProbe(true)
    expect(() =>
      window.fetch('https://www.binance.com/bapi/example', {
        method: 'POST',
      }),
    ).toThrow(thrown)
  })

  it('captures configured XHR targets without changing native calls', async () => {
    const open = vi.fn((..._args: unknown[]) => 'open-result')
    const send = vi.fn(function (this: FakeXhr, ..._args: unknown[]) {
      this.listeners.load?.()
      return 'send-result'
    })
    class FakeXhr {
      listeners: Record<string, () => void> = {}
      responseType = 'json'
      response: unknown = { code: 0 }
      responseText = ''
      status = 201
      open(...args: unknown[]): unknown {
        return open(...args)
      }
      send(...args: unknown[]): unknown {
        return send.apply(this, args)
      }
      addEventListener(type: string, listener: () => void) {
        this.listeners[type] = listener
      }
      removeEventListener(type: string, listener: () => void) {
        if (this.listeners[type] === listener) delete this.listeners[type]
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const postMessage = vi.spyOn(window, 'postMessage')
    installBinanceSquareProbe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    const xhr = new XMLHttpRequest()

    const openResult = xhr.open('POST', 'https://www.binance.com/bapi/example')
    const sendResult = xhr.send(JSON.stringify({ postId: target.id }))

    expect(open).toHaveBeenCalledWith(
      'POST',
      'https://www.binance.com/bapi/example',
    )
    expect(send).toHaveBeenCalledWith(JSON.stringify({ postId: target.id }))
    expect(openResult).toBe('open-result')
    expect(sendResult).toBe('send-result')
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          __lhBinanceProbe: true,
          observation: expect.objectContaining({ status: 201, target }),
        }),
        window.location.origin,
      )
    })
  })

  it('emits exactly once per request when an XHR instance is reused', async () => {
    class ReusedXhr {
      listeners = new Set<() => void>()
      sends = 0
      responseType = 'json'
      response: unknown = { code: 0 }
      responseText = ''
      status = 200
      open() {}
      send() {
        this.sends += 1
        this.status = 200 + this.sends
        this.response = { code: this.sends }
        for (const listener of [...this.listeners]) listener()
      }
      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.add(listener)
      }
      removeEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.delete(listener)
      }
    }
    vi.stubGlobal('XMLHttpRequest', ReusedXhr)
    const postMessage = vi.spyOn(window, 'postMessage')
    installBinanceSquareProbe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    const xhr = new XMLHttpRequest()

    xhr.open('POST', 'https://www.binance.com/bapi/post/like')
    xhr.send(JSON.stringify({ postId: target.id, text: 'first' }))
    xhr.open('POST', 'https://www.binance.com/bapi/post/share')
    xhr.send(JSON.stringify({ postId: target.id, text: 'second' }))

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(2)
    })
    const observations = postMessage.mock.calls.map(
      ([message]) =>
        (message as { observation: BinanceProbeObservation }).observation,
    )
    expect(observations.map(({ path }) => path)).toEqual([
      '/bapi/post/like',
      '/bapi/post/share',
    ])
    expect(observations.map(({ requestShape }) => requestShape)).toEqual([
      { postId: '<target:CONTENT>', text: '<string:5>' },
      { postId: '<target:CONTENT>', text: '<string:6>' },
    ])
    expect(observations.map(({ status }) => status)).toEqual([201, 202])
    expect(observations.map(({ responseShape }) => responseShape)).toEqual([
      { code: '<number>' },
      { code: '<number>' },
    ])
  })

  it('removes the request load listener when native XHR send throws', async () => {
    const thrown = new Error('sync send')
    let shouldThrow = true
    class ThrowingXhr {
      listeners = new Set<() => void>()
      responseType = 'json'
      response: unknown = { code: 0 }
      responseText = ''
      status = 200
      open() {}
      send() {
        if (shouldThrow) throw thrown
        for (const listener of [...this.listeners]) listener()
      }
      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.add(listener)
      }
      removeEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.delete(listener)
      }
    }
    vi.stubGlobal('XMLHttpRequest', ThrowingXhr)
    const postMessage = vi.spyOn(window, 'postMessage')
    installBinanceSquareProbe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    const xhr = new XMLHttpRequest() as XMLHttpRequest & ThrowingXhr

    xhr.open('POST', 'https://www.binance.com/bapi/post/like')
    expect(() =>
      xhr.send(JSON.stringify({ postId: target.id, text: 'first' })),
    ).toThrow(thrown)
    expect(xhr.listeners.size).toBe(0)

    shouldThrow = false
    xhr.open('POST', 'https://www.binance.com/bapi/post/share')
    xhr.send(JSON.stringify({ postId: target.id, text: 'second' }))
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(1)
    })
  })

  it('preserves a pending request when a reused XHR open throws', async () => {
    const thrown = new Error('invalid open')
    class FailedOpenXhr {
      listeners = new Set<() => void>()
      responseType = 'json'
      response: unknown = { code: 1 }
      responseText = ''
      status = 201
      open(_method: string, url: string) {
        if (url.includes('invalid')) throw thrown
        return 'open-result'
      }
      send() {
        return 'send-result'
      }
      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.add(listener)
      }
      removeEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.delete(listener)
      }
      fireLoad() {
        for (const listener of [...this.listeners]) listener()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FailedOpenXhr)
    const postMessage = vi.spyOn(window, 'postMessage')
    installBinanceSquareProbe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    const xhr = new XMLHttpRequest() as XMLHttpRequest & FailedOpenXhr

    expect(xhr.open('POST', 'https://www.binance.com/bapi/post/like')).toBe(
      'open-result',
    )
    expect(xhr.send(JSON.stringify({ postId: target.id, text: 'first' }))).toBe(
      'send-result',
    )
    expect(() =>
      xhr.open('POST', 'https://www.binance.com/bapi/invalid'),
    ).toThrow(thrown)
    xhr.fireLoad()

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(1)
    })
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          path: '/bapi/post/like',
          requestShape: {
            postId: '<target:CONTENT>',
            text: '<string:5>',
          },
        }),
      }),
      window.location.origin,
    )
  })

  it('preserves a pending request when a second XHR send throws', async () => {
    const thrown = new Error('invalid second send')
    let shouldThrow = false
    class FailedSecondSendXhr {
      listeners = new Set<() => void>()
      responseType = 'json'
      response: unknown = { code: 1 }
      responseText = ''
      status = 201
      open() {
        return 'open-result'
      }
      send() {
        if (shouldThrow) throw thrown
        return 'send-result'
      }
      addEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.add(listener)
      }
      removeEventListener(type: string, listener: () => void) {
        if (type === 'load') this.listeners.delete(listener)
      }
      fireLoad() {
        for (const listener of [...this.listeners]) listener()
      }
    }
    vi.stubGlobal('XMLHttpRequest', FailedSecondSendXhr)
    const postMessage = vi.spyOn(window, 'postMessage')
    installBinanceSquareProbe(true)
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbeConfig: true, targets: [target] },
      }),
    )
    const xhr = new XMLHttpRequest() as XMLHttpRequest & FailedSecondSendXhr

    xhr.open('POST', 'https://www.binance.com/bapi/post/like')
    expect(xhr.send(JSON.stringify({ postId: target.id, text: 'first' }))).toBe(
      'send-result',
    )
    shouldThrow = true
    expect(() =>
      xhr.send(JSON.stringify({ postId: target.id, text: 'second' })),
    ).toThrow(thrown)
    xhr.fireLoad()

    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledTimes(1)
    })
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        observation: expect.objectContaining({
          path: '/bapi/post/like',
          requestShape: {
            postId: '<target:CONTENT>',
            text: '<string:5>',
          },
        }),
      }),
      window.location.origin,
    )
  })
})

describe('Binance Square ISOLATED bridge', () => {
  afterEach(() => {
    installBinanceSquareBridge(false)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('rejects forged origins, sources, wrappers, and unauthorized targets', () => {
    const valid = observation()
    const event = {
      source: window,
      origin: window.location.origin,
      data: { __lhBinanceProbe: true, observation: valid },
    } as unknown as MessageEvent

    expect(
      probeObservationFromEvent(
        event,
        [target],
        window,
        window.location.origin,
      ),
    ).toEqual(valid)
    expect(
      probeObservationFromEvent(
        { ...event, origin: 'https://evil.example' } as MessageEvent,
        [target],
        window,
        window.location.origin,
      ),
    ).toBeNull()
    expect(
      probeObservationFromEvent(
        { ...event, source: null } as MessageEvent,
        [target],
        window,
        window.location.origin,
      ),
    ).toBeNull()
    expect(
      probeObservationFromEvent(
        {
          ...event,
          data: { ...event.data, rawBody: 'secret' },
        } as MessageEvent,
        [target],
        window,
        window.location.origin,
      ),
    ).toBeNull()
    expect(
      probeObservationFromEvent(
        event,
        [{ kind: 'CONTENT', id: '999999' }],
        window,
        window.location.origin,
      ),
    ).toBeNull()
  })

  it('does not register or request targets when beta capture is disabled', () => {
    const sendMessage = vi.fn()
    const addListener = vi.fn()
    vi.stubGlobal('chrome', {
      runtime: { sendMessage, onMessage: { addListener } },
    })

    installBinanceSquareBridge(false)

    expect(sendMessage).not.toHaveBeenCalled()
    expect(addListener).not.toHaveBeenCalled()
  })

  it('refreshes targets and reports only authorized observations', async () => {
    const runtimeListeners: Array<(message: unknown) => void> = []
    const sendMessage = vi.fn(async (message: { type: string }) =>
      message.type === 'get-binance-probe-targets'
        ? { type: 'binance-probe-targets', targets: [target] }
        : { type: 'ack' },
    )
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (listener: (message: unknown) => void) =>
            runtimeListeners.push(listener),
          removeListener: (listener: (message: unknown) => void) => {
            const index = runtimeListeners.indexOf(listener)
            if (index >= 0) runtimeListeners.splice(index, 1)
          },
        },
      },
    })
    const postMessage = vi.spyOn(window, 'postMessage')

    installBinanceSquareBridge(true)
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { __lhBinanceProbeConfig: true, targets: [target] },
        window.location.origin,
      )
    })
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbe: true, observation: observation() },
      }),
    )
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'report-binance-probe-observation',
        observation: observation(),
      })
    })

    runtimeListeners[0]?.({ type: 'tasks-updated' })
    await vi.waitFor(() => {
      expect(
        sendMessage.mock.calls.filter(
          ([message]) => message.type === 'get-binance-probe-targets',
        ),
      ).toHaveLength(2)
    })
  })

  it('replaces overlapping installs, cleans listeners, and reinjects', async () => {
    const runtimeListeners = new Set<(message: unknown) => void>()
    const sendMessage = vi.fn(async (message: { type: string }) =>
      message.type === 'get-binance-probe-targets'
        ? { type: 'binance-probe-targets', targets: [target] }
        : { type: 'ack' },
    )
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (listener: (message: unknown) => void) =>
            runtimeListeners.add(listener),
          removeListener: (listener: (message: unknown) => void) =>
            runtimeListeners.delete(listener),
        },
      },
    })

    const releaseFirst = installBinanceSquareBridge(true)
    const releaseSecond = installBinanceSquareBridge(true)
    await vi.waitFor(() => expect(runtimeListeners.size).toBe(1))
    sendMessage.mockClear()

    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbe: true, observation: observation() },
      }),
    )
    await vi.waitFor(() => {
      expect(
        sendMessage.mock.calls.filter(
          ([message]) => message.type === 'report-binance-probe-observation',
        ),
      ).toHaveLength(1)
    })

    releaseFirst()
    expect(runtimeListeners.size).toBe(1)
    releaseSecond()
    expect(runtimeListeners.size).toBe(0)
    sendMessage.mockClear()
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: { __lhBinanceProbe: true, observation: observation() },
      }),
    )
    await Promise.resolve()
    expect(sendMessage).not.toHaveBeenCalled()

    const releaseReinjected = installBinanceSquareBridge(true)
    expect(runtimeListeners.size).toBe(1)
    releaseReinjected()
    expect(runtimeListeners.size).toBe(0)
  })

  it('publishes only the latest overlapping target refresh', async () => {
    const runtimeListeners = new Set<(message: unknown) => void>()
    type TargetResponse = {
      type: string
      targets: readonly { kind: 'CONTENT' | 'AUTHOR'; id: string }[]
    }
    const requests = [deferred<TargetResponse>(), deferred<TargetResponse>()]
    let targetRequest = 0
    const newerTarget = { kind: 'CONTENT', id: '999999' } as const
    const sendMessage = vi.fn((message: { type: string }) => {
      if (message.type !== 'get-binance-probe-targets') {
        return Promise.resolve({ type: 'ack' })
      }
      const request = requests[targetRequest]
      targetRequest += 1
      return request.promise
    })
    vi.stubGlobal('chrome', {
      runtime: {
        sendMessage,
        onMessage: {
          addListener: (listener: (message: unknown) => void) =>
            runtimeListeners.add(listener),
          removeListener: (listener: (message: unknown) => void) =>
            runtimeListeners.delete(listener),
        },
      },
    })
    const postMessage = vi.spyOn(window, 'postMessage')
    const release = installBinanceSquareBridge(true)
    runtimeListeners.forEach((listener) => {
      listener({ type: 'tasks-updated' })
    })

    requests[1].resolve({
      type: 'binance-probe-targets',
      targets: [newerTarget],
    })
    await vi.waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(
        { __lhBinanceProbeConfig: true, targets: [newerTarget] },
        window.location.origin,
      )
    })
    requests[0].resolve({
      type: 'binance-probe-targets',
      targets: [target],
    })
    await Promise.resolve()
    await Promise.resolve()

    expect(postMessage).not.toHaveBeenCalledWith(
      { __lhBinanceProbeConfig: true, targets: [target] },
      window.location.origin,
    )
    sendMessage.mockClear()
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin: window.location.origin,
        data: {
          __lhBinanceProbe: true,
          observation: observation({ target: newerTarget }),
        },
      }),
    )
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith({
        type: 'report-binance-probe-observation',
        observation: observation({ target: newerTarget }),
      })
    })
    release()
  })
})
