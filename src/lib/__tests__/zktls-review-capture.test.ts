import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { V4Connector } from '../zktls/interpreter'
import { observeProofReview } from '../zktls/review-capture'

const fixture = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-field-difference.json', 'utf8'),
)
const postFixture = JSON.parse(
  readFileSync('test/fixtures/product-zktls-discovery-workbench.json', 'utf8'),
).cases.find(
  (entry: { connector: V4Connector }) =>
    entry.connector.request.method === 'POST',
)
const pageUrl = 'https://app.example.com/history'

function eventBus() {
  const listeners = new Set<(...args: unknown[]) => void>()
  return {
    listeners,
    addListener: vi.fn((listener: (...args: unknown[]) => void) =>
      listeners.add(listener),
    ),
    removeListener: vi.fn((listener: (...args: unknown[]) => void) =>
      listeners.delete(listener),
    ),
    emit: (...args: unknown[]) => {
      for (const listener of [...listeners]) listener(...args)
    },
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => {
    resolve = settle
  })
  return { promise, resolve }
}

function setup() {
  const events = eventBus()
  const updated = eventBus()
  const removed = eventBus()
  const detached = eventBus()
  const attach = vi.fn(async () => {})
  const detach = vi.fn(async () => {})
  const command = vi.fn(
    async (
      _target: unknown,
      method: string,
      _params?: unknown,
    ): Promise<unknown> => {
      if (method === 'Page.getFrameTree')
        return {
          frameTree: { frame: { id: 'root', loaderId: 'doc-1', url: pageUrl } },
        }
      if (method === 'Network.getResponseBody')
        return { body: '{"amount":"12"}', base64Encoded: false }
      return {}
    },
  )
  const tabs = {
    get: vi.fn(async (id: number) => ({ id, url: pageUrl })),
    create: vi.fn(),
    update: vi.fn(),
    reload: vi.fn(),
    onUpdated: updated,
    onRemoved: removed,
  }
  vi.stubGlobal('chrome', {
    tabs,
    debugger: {
      attach,
      detach,
      sendCommand: command,
      onEvent: events,
      onDetach: detached,
    },
  })
  const config: V4Connector = structuredClone(fixture.connector)
  config.variables[0].source = {
    kind: 'CAPTURED_REQUEST',
    location: 'QUERY',
    selector: 'account',
  }
  config.resolved_variables = {}
  const controller = new AbortController()
  const ready = vi.fn()
  const begin = () =>
    observeProofReview({
      tabId: 7,
      sessionId: 'session-1',
      config,
      signal: controller.signal,
      onReady: ready,
    })
  const event = (method: string, params: Record<string, unknown>, tabId = 7) =>
    events.emit({ tabId }, method, params)
  const request = (id = 'request-a', account = 'account-a', extra = {}) =>
    event('Network.requestWillBeSent', {
      requestId: id,
      frameId: 'root',
      loaderId: 'doc-1',
      type: 'Fetch',
      documentURL: pageUrl,
      request: {
        url: `https://api.example.com/v1/events?account=${account}`,
        method: 'GET',
        headers: {},
      },
      ...extra,
    })
  const finish = (id = 'request-a') => {
    event('Network.responseReceived', {
      requestId: id,
      response: { status: 200, mimeType: 'application/json' },
    })
    event('Network.loadingFinished', { requestId: id })
  }
  return {
    events,
    updated,
    removed,
    detached,
    attach,
    detach,
    command,
    tabs,
    config,
    controller,
    ready,
    begin,
    event,
    request,
    finish,
  }
}

describe('proof review current-tab CDP observer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('reads the exact POST body selected by the shared signed fixture', async () => {
    const h = setup()
    Object.assign(h.config, structuredClone(postFixture.connector))
    const observer = await h.begin()
    h.request('post', '', {
      request: {
        url: postFixture.observation.url,
        method: 'POST',
        postData: postFixture.observation.requestBody,
        headers: { 'Content-Type': 'application/json' },
      },
    })
    h.finish('post')
    const result = await observer.read
    expect(result.captured).toMatchObject({
      method: 'POST',
      path: '/v1/history',
      body: postFixture.observation.requestBody,
      content_type: 'application/json',
      secrets: {},
    })
    await observer.dispose()
  })

  it.each([
    ['matching', {}],
    ['wrong authority', { ':authority': 'other.example.com' }],
    ['wrong method', { ':method': 'GET' }],
    ['wrong scheme', { ':scheme': 'http' }],
    ['wrong path', { ':path': '/v1/other' }],
  ])('validates HTTP/2 ExtraInfo pseudo headers: %s', async (kind, overrides) => {
    const h = setup()
    Object.assign(h.config, structuredClone(postFixture.connector))
    const observer = await h.begin()
    const read = observer.read.then(
      () => 'captured',
      () => 'rejected',
    )
    h.request('post', '', {
      request: {
        url: postFixture.observation.url,
        method: 'POST',
        postData: postFixture.observation.requestBody,
        headers: { 'Content-Type': 'application/json' },
      },
    })
    h.event('Network.requestWillBeSentExtraInfo', {
      requestId: 'post',
      headers: {
        ':authority': 'api.example.com',
        ':method': 'POST',
        ':scheme': 'https',
        ':path': '/v1/history',
        'content-type': 'application/json',
        ...overrides,
      },
    })
    h.finish('post')
    await vi.advanceTimersByTimeAsync(0)
    const result = await Promise.race([read, Promise.resolve('pending')])
    await observer.dispose()
    if (kind === 'matching') expect(result).toBe('captured')
    else expect(result).not.toBe('captured')
  })

  it.each([
    'reading',
    'selected',
  ])('invalidates a Cookie change for the same request while %s', async (stage) => {
    const h = setup()
    const body = deferred<{ body: string }>()
    const observer = await h.begin()
    const read = observer.read.catch((error) => error)
    if (stage === 'reading')
      h.command.mockImplementation(async () => body.promise)
    h.request('one')
    h.event('Network.requestWillBeSentExtraInfo', {
      requestId: 'one',
      headers: { Cookie: 'session=cookie-a' },
    })
    h.finish('one')
    if (stage === 'selected') {
      const result = await read
      expect(result.captured.secrets).toEqual({})
      expect(JSON.stringify(result.captured)).not.toContain('cookie-a')
    }
    h.request('two')
    h.event('Network.requestWillBeSentExtraInfo', {
      requestId: 'two',
      headers: { Cookie: 'session=cookie-b' },
    })
    h.finish('two')
    body.resolve({ body: '{}' })
    await vi.advanceTimersByTimeAsync(0)
    const reason = await Promise.race([
      observer.invalidated,
      Promise.resolve('still-valid'),
    ])
    await observer.dispose()
    expect(reason).not.toBe('still-valid')
    await read
  })

  it('invalidates two different requests when concurrent body reads resolve out of order', async () => {
    const h = setup()
    const a = deferred<{ body: string }>()
    const b = deferred<{ body: string }>()
    const observer = await h.begin()
    const read = observer.read.then(
      (value) => value,
      (error) => error,
    )
    h.command.mockImplementation(async (_target, method, params) =>
      method === 'Network.getResponseBody'
        ? (params as { requestId: string }).requestId === 'request-a'
          ? a.promise
          : b.promise
        : {},
    )
    h.request('request-a', 'account-a')
    h.finish('request-a')
    h.request('request-b', 'account-b')
    h.finish('request-b')
    b.resolve({ body: '{"account":"account-b"}' })
    await vi.advanceTimersByTimeAsync(0)
    a.resolve({ body: '{"account":"account-a"}' })
    await vi.advanceTimersByTimeAsync(0)
    expect(
      await Promise.race([
        observer.invalidated,
        Promise.resolve('still-valid'),
      ]),
    ).toBe('REVIEW_ACCOUNT_OR_REQUEST_CHANGED')
    await expect(observer.assertCurrent()).rejects.toThrow()
    await read
    await observer.dispose()
  })

  it('coalesces identical in-flight requests instead of reading both response bodies', async () => {
    const h = setup()
    const body = deferred<{ body: string }>()
    const observer = await h.begin()
    h.command.mockImplementation(async (_target, method) =>
      method === 'Network.getResponseBody' ? body.promise : {},
    )
    h.request('one')
    h.finish('one')
    h.request('two')
    h.finish('two')
    expect(
      h.command.mock.calls.filter(
        (call) => call[1] === 'Network.getResponseBody',
      ),
    ).toHaveLength(1)
    body.resolve({ body: '{}' })
    await observer.read
    await observer.dispose()
  })

  it('reads only the existing tab without navigation or creating tabs', async () => {
    const h = setup()
    const observer = await h.begin()
    h.request()
    h.finish()
    expect(await observer.read).toMatchObject({
      responseBody: '{"amount":"12"}',
      contentType: 'application/json',
      status: 200,
      pageUrl,
      captured: { path: '/v1/events?account=account-a' },
    })
    expect(h.attach).toHaveBeenCalledWith({ tabId: 7 }, '1.3')
    expect(h.ready).toHaveBeenCalledOnce()
    expect(h.tabs.create).not.toHaveBeenCalled()
    expect(h.tabs.update).not.toHaveBeenCalled()
    expect(h.tabs.reload).not.toHaveBeenCalled()
    expect(
      h.command.mock.calls.some((call) => /navigate|reload/i.test(call[1])),
    ).toBe(false)
    await observer.dispose()
  })

  it('does not detach another debugger when attachment fails', async () => {
    const h = setup()
    h.attach.mockRejectedValue(new Error('already attached'))
    await expect(h.begin()).rejects.toThrow('already attached')
    expect(h.detach).not.toHaveBeenCalled()
    expect(h.events.listeners.size).toBe(0)
    expect(h.updated.listeners.size).toBe(0)
  })

  it('settles cancellation even while debugger attachment is still pending', async () => {
    const h = setup()
    const attached = deferred<void>()
    h.attach.mockImplementation(() => attached.promise)
    const start = h.begin().then(
      () => 'started',
      () => 'cancelled',
    )
    await vi.advanceTimersByTimeAsync(0)
    h.controller.abort()
    await vi.advanceTimersByTimeAsync(0)
    const outcome = await Promise.race([
      start,
      Promise.resolve('still-pending'),
    ])
    // Release the browser mock even on the failing implementation.
    attached.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(outcome).toBe('cancelled')
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.ready).not.toHaveBeenCalled()
  })

  it.each([
    'before',
    'after',
  ])('accepts request ExtraInfo headers %s requestWillBeSent', async (order) => {
    const h = setup()
    const observer = await h.begin()
    const headers = () =>
      h.event('Network.requestWillBeSentExtraInfo', {
        requestId: 'request-a',
        headers: { 'Content-Type': 'application/json' },
      })
    if (order === 'before') headers()
    h.request()
    if (order === 'after') headers()
    h.finish()
    expect((await observer.read).captured.path).toContain('account-a')
    await observer.dispose()
  })

  it('ignores other tabs, child frames, old documents and foreign initiating pages', async () => {
    const h = setup()
    const observer = await h.begin()
    h.event('Network.requestWillBeSent', { requestId: 'foreign' }, 8)
    h.request('child', 'account-a', { frameId: 'child' })
    h.request('old', 'account-a', { loaderId: 'old-doc' })
    h.request('origin', 'account-a', {
      documentURL: 'https://foreign.example/',
    })
    for (const id of ['foreign', 'child', 'old', 'origin']) h.finish(id)
    expect(
      h.command.mock.calls.filter(
        (call) => call[1] === 'Network.getResponseBody',
      ),
    ).toHaveLength(0)
    h.request()
    h.finish()
    await observer.read
    await observer.dispose()
  })

  it('invalidates on cross-origin navigation before a body read can publish', async () => {
    const h = setup()
    const body = deferred<{ body: string }>()
    const observer = await h.begin()
    const read = observer.read.catch((error) => error)
    h.command.mockImplementation(async () => body.promise)
    h.request()
    h.finish()
    h.updated.emit(7, { url: 'https://other.example/' })
    body.resolve({ body: '{"private":true}' })
    expect(await observer.invalidated).toBe('REVIEW_ORIGIN_CHANGED')
    expect(await read).toBeInstanceOf(Error)
    await expect(observer.assertCurrent()).rejects.toThrow(
      'REVIEW_ORIGIN_CHANGED',
    )
    await observer.dispose()
  })

  it('keeps unavailable bodies explicit when CDP body access fails', async () => {
    const h = setup()
    const observer = await h.begin()
    h.command.mockRejectedValue(new Error('body evicted'))
    h.request()
    h.finish()
    expect(await observer.read).toMatchObject({
      responseBody: undefined,
      status: 200,
    })
    await observer.dispose()
  })

  it('does not associate a redirect response with the original signed request', async () => {
    const h = setup()
    const observer = await h.begin()
    const read = observer.read.then(
      () => 'captured',
      () => 'invalidated',
    )
    h.request()
    h.request('request-a', 'account-a', {
      redirectResponse: { status: 302 },
      request: {
        url: 'https://outside.example/login',
        method: 'GET',
        headers: {},
      },
    })
    h.finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(await Promise.race([read, Promise.resolve('pending')])).not.toBe(
      'captured',
    )
    expect(
      h.command.mock.calls.some(
        (call) => call[1] === 'Network.getResponseBody',
      ),
    ).toBe(false)
    await observer.dispose()
  })

  it('decodes bounded base64 response bytes as UTF-8', async () => {
    const h = setup()
    const observer = await h.begin()
    h.command.mockResolvedValue({
      body: Buffer.from('{"name":"测试"}', 'utf8').toString('base64'),
      base64Encoded: true,
    })
    h.request()
    h.finish()
    expect((await observer.read).responseBody).toBe('{"name":"测试"}')
    await observer.dispose()
  })

  it('skips body fetching when decoded network bytes exceed the existing cap', async () => {
    const h = setup()
    const observer = await h.begin()
    h.request()
    h.event('Network.dataReceived', {
      requestId: 'request-a',
      dataLength: 65_537,
    })
    h.finish()
    expect((await observer.read).responseBody?.length).toBeGreaterThan(65_536)
    expect(
      h.command.mock.calls.some(
        (call) => call[1] === 'Network.getResponseBody',
      ),
    ).toBe(false)
    await observer.dispose()
  })

  it('expires a waiting capture at its bounded TTL', async () => {
    const h = setup()
    const observer = await h.begin()
    const read = observer.read.catch((error) => error)
    await vi.advanceTimersByTimeAsync(120_000)
    expect(await observer.invalidated).toBe('NO_REQUEST_OBSERVED')
    expect(await read).toBeInstanceOf(Error)
    await observer.dispose()
  })

  it('settles the pending read when explicitly disposed and detaches only once', async () => {
    const h = setup()
    const observer = await h.begin()
    const read = observer.read.then(
      () => 'resolved',
      () => 'cancelled',
    )
    await observer.dispose()
    await observer.dispose()
    expect(await Promise.race([read, Promise.resolve('still-pending')])).toBe(
      'cancelled',
    )
    expect(h.detach).toHaveBeenCalledOnce()
    expect(h.events.listeners.size).toBe(0)
    expect(h.updated.listeners.size).toBe(0)
  })

  it('invalidates a selected preview on tab removal and prevents future confirmation', async () => {
    const h = setup()
    const observer = await h.begin()
    h.request()
    h.finish()
    await observer.read
    h.removed.emit(7)
    expect(await observer.invalidated).toBe('REVIEW_TAB_CLOSED')
    await expect(observer.assertCurrent()).rejects.toThrow()
    await observer.dispose()
  })
})
