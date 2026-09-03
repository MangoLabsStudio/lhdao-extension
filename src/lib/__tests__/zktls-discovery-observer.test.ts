import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  installPageApiObserver,
  type PageApiObservation,
} from '../zktls/discovery/page-api-observer'

const API = 'https://archive.example/api'
const cleanups: Array<() => void> = []
const originalFetch = window.fetch

function start(options = {}) {
  const observations: PageApiObservation[] = []
  cleanups.push(
    installPageApiObserver({
      onObservation: (value) => observations.push(value),
      ...options,
    }),
  )
  return observations
}

function reply(body = '{"ok":true}', contentType = 'application/json') {
  return new Response(body, {
    status: 201,
    headers: { 'content-type': contentType },
  })
}

afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
  window.fetch = originalFetch
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('explicit page API discovery observer', () => {
  it('preserves fetch receiver, exact arguments, promise and response identity', async () => {
    const response = reply()
    const promise = Promise.resolve(response)
    const native = vi.fn(() => promise)
    window.fetch = native
    const observations = start()
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"account":7}',
    }
    const receiver = {} as Window
    const result = window.fetch.call(receiver, API, init)
    expect(result).toBe(promise)
    expect(native.mock.contexts[0]).toBe(receiver)
    expect(native.mock.calls[0]).toEqual([API, init])
    expect(await result).toBe(response)
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(response.bodyUsed).toBe(false)
    expect(await response.json()).toEqual({ ok: true })
    expect(observations[0]).toMatchObject({
      transport: 'fetch',
      url: API,
      method: 'POST',
      status: 201,
      requestBody: { account: 7 },
      responseBody: { ok: true },
      requestBodyState: 'json',
      responseBodyState: 'json',
      requestBodyBytes: 13,
      responseBodyBytes: 11,
    })
  })

  it('preserves rejection identity and synchronous throws', async () => {
    const error = new Error('network')
    const rejected = Promise.reject(error)
    window.fetch = vi.fn(() => rejected)
    start()
    const returned = window.fetch(API)
    expect(returned).toBe(rejected)
    await expect(returned).rejects.toBe(error)
    cleanups.pop()?.()
    window.fetch = vi.fn(() => {
      throw error
    })
    start()
    expect(() => window.fetch(API)).toThrow(error)
  })

  it('clones Request bodies before the page fetch consumes them', async () => {
    const request = new Request(API, { method: 'POST', body: '{"id":1}' })
    window.fetch = vi.fn(async (input) => {
      await (input as Request).text()
      return reply()
    })
    const observations = start()
    await window.fetch(request)
    await vi.waitFor(() =>
      expect(observations[0]?.requestBody).toEqual({ id: 1 }),
    )
    expect(request.bodyUsed).toBe(true)
  })

  it.each([
    ['hello', 'text/plain', 'unsupported'],
    ['bad json', 'application/json', 'invalid'],
    [`"${'x'.repeat(65_536)}"`, 'application/json', 'oversize'],
    [`"${'汉'.repeat(30_000)}"`, 'application/json', 'oversize'],
  ])('keeps %s responses metadata-only (%s)', async (body, mime, state) => {
    const response = reply(body, mime)
    window.fetch = vi.fn(async () => response)
    const observations = start()
    await window.fetch(API)
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0].responseBodyState).toBe(state)
    expect(observations[0]).not.toHaveProperty('responseBody')
    expect(response.bodyUsed).toBe(false)
  })

  it('bounds decoded streaming bytes and cancels only the clone reader', async () => {
    const cancel = vi.fn(async () => undefined)
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(33_000).fill(32),
    }))
    const clone = vi.fn(() => ({
      body: { getReader: () => ({ read, cancel, releaseLock() {} }) },
    }))
    window.fetch = vi.fn(
      async () =>
        ({
          status: 200,
          headers: new Headers({
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '10',
          }),
          clone,
        }) as unknown as Response,
    )
    const observations = start()
    await window.fetch(API)
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(read).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(observations[0].responseBodyState).toBe('oversize')
  })

  it('checks scope before cloning or parsing and contains callback/clone failures', async () => {
    const clone = vi.fn(() => {
      throw new Error('unreadable')
    })
    window.fetch = vi.fn(
      async () =>
        ({
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          clone,
        }) as unknown as Response,
    )
    const observations = start({ acceptsUrl: (url: string) => url === API })
    await window.fetch('https://outside.example/api')
    await Promise.resolve()
    expect(clone).not.toHaveBeenCalled()
    await window.fetch(API)
    await vi.waitFor(() =>
      expect(observations[0]?.responseBodyState).toBe('unreadable'),
    )
    cleanups.pop()?.()
    start({
      onObservation: () => {
        throw new Error('callback')
      },
    })
    await window.fetch(API)
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  it('cancels a pending clone read on stop without touching the page body', async () => {
    let finish!: (value: ReadableStreamReadResult<Uint8Array>) => void
    const read = vi.fn(
      () =>
        new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) => {
          finish = resolve
        }),
    )
    const cancel = vi.fn(async () => {
      finish({ done: true, value: undefined })
    })
    const originalBodyCancel = vi.fn()
    const response = reply()
    Object.defineProperty(response, 'body', {
      value: { cancel: originalBodyCancel },
    })
    vi.spyOn(response, 'clone').mockReturnValue({
      body: { getReader: () => ({ read, cancel, releaseLock() {} }) },
    } as unknown as Response)
    window.fetch = vi.fn(async () => response)
    const observations = start()
    expect(await window.fetch(API)).toBe(response)
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce())
    cleanups.pop()?.()
    await Promise.resolve()
    expect(cancel).toHaveBeenCalledOnce()
    expect(originalBodyCancel).not.toHaveBeenCalled()
    expect(observations).toHaveLength(0)
  })

  it('stops in-flight inspection and restores only owned wrappers', async () => {
    let resolve!: (response: Response) => void
    const native = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    window.fetch = native
    const ready = vi.fn()
    const observations = start({ onReady: ready })
    expect(ready).toHaveBeenCalledOnce()
    const result = window.fetch(API)
    const newer = vi.fn(async () => reply())
    window.fetch = newer
    cleanups.pop()?.()
    expect(window.fetch).toBe(newer)
    resolve(reply())
    await result
    await Promise.resolve()
    expect(observations).toHaveLength(0)
  })

  it('does no inspection when a newer wrapper retains the stopped wrapper', async () => {
    window.fetch = vi.fn(async () => reply())
    const scope = vi.fn(() => true)
    start({ acceptsUrl: scope })
    const wrapped = window.fetch
    window.fetch = (...args) => wrapped(...args)
    cleanups.pop()?.()
    await window.fetch(API)
    expect(scope).not.toHaveBeenCalled()
  })

  it.each([
    ['x'.repeat(65_537), 'oversize'],
    [new FormData(), 'unsupported'],
    [new Blob(['{"blob":true}']), 'json'],
    [new TextEncoder().encode('{"bytes":true}'), 'json'],
  ])('handles request bodies without replacing them (%s)', async (body, expected) => {
    const native = vi.fn<typeof fetch>(async () => reply())
    window.fetch = native
    const observations = start()
    const init = { method: 'POST', body }
    await window.fetch(API, init)
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0].requestBodyState).toBe(expected)
    expect(native.mock.calls[0]?.[1]).toBe(init)
  })
})

class FakeXhr extends EventTarget {
  responseType: XMLHttpRequestResponseType = ''
  responseText = '{"value":1}'
  response: unknown = { value: 1 }
  status = 200
  timeout = 0
  pending = false
  async = true
  calls: unknown[][] = []
  open(...args: unknown[]) {
    if (args[1] === 'invalid') throw new Error('open')
    this.calls.push(['open', ...args])
    this.async = args[2] !== false
  }
  setRequestHeader(...args: unknown[]) {
    this.calls.push(['header', ...args])
  }
  send(...args: unknown[]) {
    if (this.pending) throw new Error('send')
    this.calls.push(['send', ...args])
    this.pending = true
    if (!this.async) this.finish()
  }
  getAllResponseHeaders() {
    return 'content-type: application/json\r\nx-api: yes\r\n'
  }
  getResponseHeader(name: string) {
    return name === 'content-type' ? 'application/json' : null
  }
  finish() {
    this.pending = false
    for (const name of ['readystatechange', 'load', 'loadend'])
      this.dispatchEvent(new Event(name))
  }
}

describe('XHR discovery semantics', () => {
  it('rejects enormous sparse JSON arrays before serialization', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const observations = start()
    const xhr = new FakeXhr()
    xhr.responseType = 'json'
    xhr.response = new Array(100_000)
    xhr.open('GET', API)
    xhr.send()
    xhr.finish()
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0].responseBodyState).toBe('oversize')
  })

  it('does not invoke getters in page-controlled JSON objects', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const observations = start()
    const xhr = new FakeXhr()
    xhr.responseType = 'json'
    const getter = vi.fn(() => 'private')
    xhr.response = Object.defineProperty({}, 'secret', {
      enumerable: true,
      get: getter,
    })
    xhr.open('GET', API)
    xhr.send()
    xhr.finish()
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0].responseBodyState).toBe('unreadable')
    expect(getter).not.toHaveBeenCalled()
  })
  it('preserves sync mode, timeout, return values and page event order', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const observations = start()
    const xhr = new FakeXhr()
    const events: string[] = []
    for (const name of ['readystatechange', 'load', 'loadend'])
      xhr.addEventListener(name, () => events.push(name))
    xhr.timeout = 700
    expect(xhr.open('POST', API, false, 'user', 'password')).toBeUndefined()
    xhr.setRequestHeader('content-type', 'application/json')
    expect(xhr.send('{"a":2}')).toBeUndefined()
    expect(events).toEqual(['readystatechange', 'load', 'loadend'])
    expect(xhr.timeout).toBe(700)
    expect(xhr.responseType).toBe('')
    expect(xhr.calls).toEqual([
      ['open', 'POST', API, false, 'user', 'password'],
      ['header', 'content-type', 'application/json'],
      ['send', '{"a":2}'],
    ])
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0]).toMatchObject({
      transport: 'xhr',
      requestBody: { a: 2 },
      responseBody: { value: 1 },
    })
  })

  it('retains pending observations across failed open/send and supports reuse', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const observations = start()
    const xhr = new FakeXhr()
    xhr.open('GET', API)
    xhr.setRequestHeader('x-request', 'first')
    xhr.send('{"first":true}')
    expect(() => xhr.open('GET', 'invalid')).toThrow('open')
    expect(() => xhr.send('second')).toThrow('send')
    xhr.finish()
    await vi.waitFor(() => expect(observations).toHaveLength(1))
    expect(observations[0]).toMatchObject({
      requestHeaders: [['x-request', 'first']],
      requestBody: { first: true },
    })
    xhr.open('GET', `${API}/2`)
    xhr.responseType = 'json'
    xhr.send()
    xhr.finish()
    await vi.waitFor(() => expect(observations).toHaveLength(2))
    expect(observations[1]).toMatchObject({
      responseBody: { value: 1 },
      requestBodyState: 'empty',
      requestHeaders: [],
    })
  })

  it('does not read responseText for unsupported response types or after stop', async () => {
    vi.stubGlobal('XMLHttpRequest', FakeXhr)
    const observations = start()
    const xhr = new FakeXhr()
    xhr.responseType = 'arraybuffer'
    Object.defineProperty(xhr, 'responseText', {
      get: () => {
        throw new Error('invalid access')
      },
    })
    xhr.open('GET', API)
    xhr.send()
    xhr.finish()
    await vi.waitFor(() =>
      expect(observations[0]?.responseBodyState).toBe('unsupported'),
    )
    xhr.open('GET', API)
    xhr.send()
    cleanups.pop()?.()
    xhr.finish()
    await Promise.resolve()
    expect(observations).toHaveLength(1)
  })
})

describe('runtime discovery entrypoint', () => {
  it('handles invalidation inside the ready callback', async () => {
    const { createDiscoveryContentController } = await import(
      '../../entrypoints/zktls-discovery.content'
    )
    const native = window.fetch
    let invalidate = () => {}
    const controller = createDiscoveryContentController({
      isInvalid: false,
      onInvalidated: (callback) => {
        invalidate = callback
      },
    })
    controller.start({ onObservation: () => {}, onReady: () => invalidate() })
    expect(window.fetch).toBe(native)
  })

  it('is MAIN-world runtime-only and stays idle until explicitly started', async () => {
    const entry = await import('../../entrypoints/zktls-discovery.content')
    expect(entry.default).toMatchObject({
      registration: 'runtime',
      world: 'MAIN',
    })
    expect(entry.default).not.toHaveProperty('matches')
    const native = window.fetch
    let invalidate = () => {}
    const context = {
      isInvalid: false,
      onInvalidated: (callback: () => void) => {
        invalidate = callback
      },
    }
    const controller = entry.createDiscoveryContentController(context)
    expect(window.fetch).toBe(native)
    const ready = vi.fn()
    controller.start({ onObservation: () => {}, onReady: ready })
    expect(ready).toHaveBeenCalledOnce()
    expect(window.fetch).not.toBe(native)
    invalidate()
    expect(window.fetch).toBe(native)
    controller.start({ onObservation: () => {}, onReady: ready })
    expect(window.fetch).toBe(native)
    expect(ready).toHaveBeenCalledOnce()
  })
})
