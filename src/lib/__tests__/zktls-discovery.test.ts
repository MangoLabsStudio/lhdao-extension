import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateStore } from '../zktls/discovery/candidate-store'
import { safeClone } from '../zktls/discovery/redaction'
import { parseDiscoveryResponse } from '../zktls/discovery/response-contract'
import { DiscoverySessionManager } from '../zktls/discovery/session-manager'

const discoveryFixture = JSON.parse(
  readFileSync('test/fixtures/product-zktls-discovery-workbench.json', 'utf8'),
)

const owner = {
  id: 'extension',
  frameId: 0,
  documentId: 'owner-doc',
  tab: { id: 7 } as chrome.tabs.Tab,
  url: 'https://app.lhdao.top/workbench',
}
const start = {
  type: 'start-discovery',
  correlationId: 'request-123',
  targetUrl: 'https://client.example/app',
}
const observation = (body = { operation: 'balances', amount: 10 }) => ({
  method: 'POST',
  url: 'https://api.example/accounts/alice?token=SECRET_QUERY&cursor=123',
  requestHeaders: {
    Authorization: 'SECRET_AUTH',
    Cookie: 'SECRET_COOKIE',
    'Content-Type': 'application/json',
  },
  requestBody: JSON.stringify(body),
  responseBody: JSON.stringify({ balance: 20, wallet: 'SECRET_WALLET' }),
  contentType: 'application/json',
  status: 200,
})

describe('discovery candidate privacy and inference', () => {
  it('projects the shared synthetic observations into the exact redacted candidates', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2029-12-31T23:49:00Z'))
    const uuid = vi.spyOn(crypto, 'randomUUID')
    try {
      for (const entry of [
        ...discoveryFixture.cases.slice(0, 3),
        discoveryFixture.unsupported,
      ]) {
        uuid.mockReturnValue(entry.candidate.candidateId)
        const store = new CandidateStore()
        expect(store.add(entry.observation)).toBe('added')
        expect(store.snapshot().candidates).toEqual([entry.candidate])
        store.clear()
        expect(store.snapshot().candidates).toEqual([])
      }
    } finally {
      vi.restoreAllMocks()
    }
  })
  it('redacts bare bearer, proxy authorization and individual cookie values in echoes', () => {
    const store = new CandidateStore()
    store.add({
      ...observation(),
      requestHeaders: {
        Authorization: 'Bearer short-secret',
        'Proxy-Authorization': 'Bearer short-proxy',
        Cookie: 'session=short-cookie; other=second-cookie',
      },
      responseBody: JSON.stringify({
        echo: 'short-secret',
        other: 'short-cookie',
        proxy: 'short-proxy',
        nested: { repeated: 'second-cookie' },
      }),
    })
    const serialized = JSON.stringify(store.snapshot())
    for (const secret of [
      'short-secret',
      'short-cookie',
      'short-proxy',
      'second-cookie',
    ])
      expect(serialized).not.toContain(secret)
  })
  it('redacts before insertion, merges dynamic samples and splits operations', () => {
    const store = new CandidateStore()
    store.add(observation())
    store.add(observation({ operation: 'balances', amount: 11 }))
    store.add(observation({ operation: 'orders', amount: 11 }))
    const result = store.snapshot()
    expect(result.candidates).toHaveLength(2)
    expect(result.candidates[0].occurrences).toBe(2)
    expect(result.candidates[0].inference.dynamicFields).toContain(
      'request.amount',
    )
    const text = JSON.stringify(result)
    for (const secret of [
      'SECRET_QUERY',
      'SECRET_AUTH',
      'SECRET_COOKIE',
      'SECRET_WALLET',
      'alice',
    ])
      expect(text).not.toContain(secret)
    expect(text).toContain('balances')
    expect(text).toContain('balance')
    expect(Object.isFrozen(result.candidates[0].samples[0])).toBe(true)
    expect(() => {
      result.candidates[0].occurrences = 99
    }).toThrow()
    expect(store.snapshot().candidates[0].occurrences).toBe(2)
  })

  it('bounds samples but continues occurrence metadata, then erases on clear', () => {
    const store = new CandidateStore()
    for (let i = 0; i < 10; i++)
      store.add(observation({ operation: 'balances', amount: i }))
    expect(store.snapshot().candidates[0]).toMatchObject({
      occurrences: 10,
      samples: expect.any(Array),
    })
    expect(store.snapshot().candidates[0].samples).toHaveLength(3)
    store.clear()
    expect(store.snapshot().candidates).toEqual([])
  })

  it('keeps oversized, non-JSON and unavailable responses metadata only', () => {
    const store = new CandidateStore()
    for (const responseBody of ['x'.repeat(65537), 'not json', undefined])
      expect(store.add({ ...observation(), responseBody })).toBe('added')
    expect(store.snapshot().candidates).toHaveLength(3)
    expect(
      store
        .snapshot()
        .candidates.every(
          (c) => !c.configurable && c.samples.every((s) => s.response === null),
        ),
    ).toBe(true)
  })

  it('removes credential echoes, account path/query/JSON IDs and emits only safe framing headers', () => {
    const store = new CandidateStore()
    store.add({
      ...observation(),
      documentUrl: 'https://client.example/profile/alice?token=page-secret',
      requestBody: '{"apiKey":"body-secret","mirror":"body-secret"}',
      responseBody:
        '{"echo":"SECRET_AUTH","ref":"body-secret","accountId":1234,"balance":5}',
      responseHeaders: {
        'Content-Encoding': 'gzip',
        'Transfer-Encoding': 'chunked',
        'Set-Cookie': 'header-secret',
        'X-Secret': 'another-secret',
      },
    })
    const candidate = store.snapshot().candidates[0]
    const text = JSON.stringify(candidate)
    for (const secret of [
      'SECRET_AUTH',
      'body-secret',
      'header-secret',
      'another-secret',
      'alice',
      '1234',
      'page-secret',
    ])
      expect(text).not.toContain(secret)
    expect(candidate.samples[0]).toMatchObject({
      pageOrigin: 'https://client.example',
      triggerPathSafe: false,
      responseHeaders: {
        'content-encoding': 'gzip',
        'transfer-encoding': 'chunked',
      },
    })
    expect(candidate.samples[0].request.headers).toEqual({
      'content-type': 'application/json',
    })
  })

  it('keeps request and response content types distinct and captures safe observed SPA trigger', () => {
    const store = new CandidateStore()
    store.add({
      ...observation(),
      requestHeaders: {},
      requestBody: '',
      documentUrl: 'https://client.example/trade/orders',
      responseHeaders: {
        'Content-Type': 'application/json',
        'Content-Length': '14',
      },
    })
    expect(store.snapshot().candidates[0]).toMatchObject({
      requestContentType: '',
      contentType: 'application/json',
      samples: [
        {
          pageOrigin: 'https://client.example',
          triggerPath: '/trade/orders',
          triggerPathSafe: true,
          request: { contentType: '', bodyBytes: 0 },
          responseHeaders: {
            'content-type': 'application/json',
            'content-length': '14',
          },
        },
      ],
    })
  })

  it('preserves exact safe trigger queries, encoding and duplicate keys', () => {
    const store = new CandidateStore()
    const path = '/history?tab=deposits&q=a%20b&q=c%2Fd'
    store.add({
      ...observation(),
      documentUrl: `https://client.example${path}`,
    })
    expect(store.snapshot().candidates[0].samples[0]).toMatchObject({
      triggerPath: path,
      triggerPathSafe: true,
    })
  })

  it('splits numeric operation selectors while masking generic identifiers', () => {
    const store = new CandidateStore()
    for (const op of [1, 2])
      store.add({
        ...observation({ operation: 'query', amount: 1 }),
        requestBody: JSON.stringify({ op }),
        responseBody:
          '{"id":"12345678901234567890","amount":"193425610999999999999"}',
      })
    expect(store.snapshot().candidates).toHaveLength(2)
    expect(store.snapshot().candidates[0].samples[0].response).toEqual({
      id: '[REDACTED]',
      amount: '193425610999999999999',
    })
  })

  it('keeps container shapes distinct, merges query ordering and dynamic UUIDs', () => {
    const store = new CandidateStore()
    for (const url of [
      'https://api.example/item/9dbd3ee9-dba6-4772-aa83-f97d6917b746?b=2&a=1',
      'https://api.example/item/96a78dc5-a45b-44cd-9e10-f97d6917b746?a=1&b=2',
    ])
      store.add({ ...observation(), url })
    expect(store.snapshot().candidates[0].occurrences).toBe(2)
    store.add({ ...observation(), responseBody: '{"items":[]}' })
    store.add({ ...observation(), responseBody: '{"items":{}}' })
    expect(store.snapshot().candidates).toHaveLength(3)
  })

  it('preserves exact encoded safe paths, metric decimals and safe custom headers', () => {
    const store = new CandidateStore()
    store.add({
      ...observation(),
      url: 'https://api.example/a%2Fb',
      documentUrl: 'https://client.example/app',
      requestHeaders: { 'x-client-type': 'web', Cookie: 'private-cookie' },
      responseBody:
        '{"amount":"193425610999999999999","accountId":"123456789012345678901","wallet":"0x1234567890abcdef1234567890abcdef12345678"}',
    })
    expect(store.snapshot().candidates[0]).toMatchObject({
      path: '/a%2Fb',
      configurable: true,
      samples: [
        {
          request: { headers: { 'x-client-type': 'web' } },
          response: {
            amount: '193425610999999999999',
            accountId: '[REDACTED]',
            wallet: '[REDACTED]',
          },
        },
      ],
    })
  })

  it('enforces the session byte limit while every body stays within its own quota', () => {
    const store = new CandidateStore()
    let quota = false
    for (let i = 0; i < 100; i++) {
      const result = store.add({
        ...observation(),
        url: `https://api.example/big-${i}`,
        responseBody: JSON.stringify({
          values: Array.from({ length: 6000 }, (_, i) => i + 0.1234),
        }),
      })
      if (result === 'quota') {
        quota = true
        break
      }
    }
    expect(quota).toBe(true)
    expect(store.snapshot().quota.bytes).toBeLessThanOrEqual(5242880)
  })

  it('does not collapse batched operations and deduplicates header order', () => {
    const store = new CandidateStore()
    const common = {
      ...observation(),
      requestHeaders: { 'x-client-type': 'web', Accept: 'application/json' },
    }
    store.add({ ...common, requestBody: '[{"op":"one"},{"op":"tail"}]' })
    store.add({ ...common, requestBody: '[{"op":"two"},{"op":"tail"}]' })
    store.add({
      ...common,
      requestHeaders: { Accept: 'application/json', 'x-client-type': 'web' },
      requestBody: '[{"op":"two"},{"op":"tail"}]',
    })
    expect(store.snapshot().candidates).toHaveLength(2)
    expect(store.snapshot().candidates[1].occurrences).toBe(2)
  })

  it('keeps redaction-expanded samples under 64KiB and strips csrf headers', () => {
    const store = new CandidateStore()
    store.add({
      ...observation(),
      requestHeaders: { 'x-csrf': 'CANARY_CSRF' },
      requestBody: '{"token":"a"}',
      responseBody: JSON.stringify(Array.from({ length: 6000 }, () => 'a')),
    })
    expect(store.snapshot().candidates[0]).toMatchObject({
      configurable: false,
      samples: [{ response: null, responseBodyState: 'oversize' }],
    })
    expect(JSON.stringify(store.snapshot())).not.toContain('CANARY_CSRF')
  })

  it('rejects exotic objects, getters, and proxies without invoking getters', () => {
    const getter = vi.fn(() => 'secret')
    const poisoned = {
      get responseBody() {
        return getter()
      },
    }
    expect(safeClone(poisoned)).toBeNull()
    expect(safeClone(new Date())).toBeNull()
    expect(safeClone(new Proxy({}, {}))).toBeNull()
    expect(new CandidateStore().add(poisoned)).toBe('invalid')
    expect(getter).not.toHaveBeenCalled()
  })

  it('caps candidates at 100 without evicting approved observations', () => {
    const store = new CandidateStore()
    for (let i = 0; i < 100; i++)
      expect(
        store.add({
          ...observation(),
          url: `https://api.example/operation-${i}`,
        }),
      ).toBe('added')
    expect(
      store.add({ ...observation(), url: 'https://api.example/extra' }),
    ).toBe('quota')
    expect(store.snapshot().candidates).toHaveLength(100)
  })
})

describe('native discovery vertical slice', () => {
  let manager: DiscoverySessionManager
  let event: (
    source: { tabId: number },
    method: string,
    params: unknown,
  ) => void
  let detached: (source: { tabId: number }) => void
  let command: ReturnType<typeof vi.fn>
  let detach: ReturnType<typeof vi.fn>
  let attach: ReturnType<typeof vi.fn>
  let create: ReturnType<typeof vi.fn>
  let changed: ReturnType<typeof vi.fn>
  let sessionId: string
  let body = { body: JSON.stringify({ balance: 42 }), base64Encoded: false }

  beforeEach(() => {
    vi.useFakeTimers()
    Object.defineProperty(chrome.runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    attach = vi.fn().mockResolvedValue(undefined)
    detach = vi.fn().mockResolvedValue(undefined)
    command = vi.fn(async (_target, method) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'root', loaderId: 'doc1', url: start.targetUrl },
            },
          }
        : method === 'Network.getResponseBody'
          ? body
          : {},
    )
    Object.defineProperty(chrome, 'debugger', {
      configurable: true,
      value: {
        attach,
        detach,
        sendCommand: command,
        onEvent: {
          addListener: (listener: typeof event) => {
            event = listener
          },
          removeListener: vi.fn(),
        },
        onDetach: {
          addListener: (listener: typeof detached) => {
            detached = listener
          },
          removeListener: vi.fn(),
        },
      },
    })
    create = vi.spyOn(chrome.tabs, 'create').mockImplementation((async () => ({
      id: 8,
      url: start.targetUrl,
    })) as never)
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => ({
      id,
      url: id === 7 ? owner.url : start.targetUrl,
    })) as never)
    changed = vi.spyOn(chrome.tabs, 'sendMessage').mockResolvedValue(undefined)
    vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation(
      () => undefined,
    )
    vi.spyOn(chrome.tabs.onRemoved, 'addListener').mockImplementation(
      () => undefined,
    )
    manager = new DiscoverySessionManager('https://app.lhdao.top')
  })
  afterEach(() => {
    manager.dispose()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })
  async function begin() {
    const result = await manager.handle(start, owner)
    expect(
      parseDiscoveryResponse(result, { ...start, type: 'start-discovery' }),
    ).toEqual(result)
    expect(result).toMatchObject({
      type: 'discovery-result',
      ok: true,
      snapshot: { status: 'ready' },
    })
    sessionId = (result as { snapshot: { sessionId: string } }).snapshot
      .sessionId
  }
  async function snapshot(sender = owner, id = sessionId) {
    const query = {
      type: 'get-discovery-snapshot' as const,
      correlationId: 'snapshot-123',
      sessionId: id,
    }
    const result = await manager.handle(query, sender)
    expect(parseDiscoveryResponse(result, query)).toEqual(result)
    return result
  }
  function request(id = 'req1', extra = {}) {
    event({ tabId: 8 }, 'Network.requestWillBeSent', {
      requestId: id,
      frameId: 'root',
      loaderId: 'doc1',
      documentURL: start.targetUrl,
      type: 'Fetch',
      request: {
        url: 'https://api.example/balance',
        method: 'GET',
        headers: { Cookie: 'SECRET_COOKIE' },
      },
      ...extra,
    })
    event({ tabId: 8 }, 'Network.responseReceived', {
      requestId: id,
      type: 'Fetch',
      response: {
        status: 200,
        mimeType: 'application/json',
        headers: { 'content-encoding': 'gzip' },
      },
    })
  }
  async function finish(id = 'req1') {
    event({ tabId: 8 }, 'Network.loadingFinished', { requestId: id })
    await vi.advanceTimersByTimeAsync(0)
  }
  it.each([
    discoveryFixture.cases[0],
    discoveryFixture.cases[1],
    discoveryFixture.cases[2],
  ])('captures shared $resourceType/$name only after ready and explicit page activity', async (entry) => {
    const targetUrl = entry.observation.documentUrl
    create.mockResolvedValue({ id: 8, url: targetUrl })
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => ({
      id,
      url: id === 7 ? owner.url : targetUrl,
    })) as never)
    command.mockImplementation(async (_target, method) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'root', loaderId: 'doc1', url: targetUrl },
            },
          }
        : method === 'Network.getResponseBody'
          ? { body: entry.responseJson, base64Encoded: false }
          : {},
    )
    const result = await manager.handle({ ...start, targetUrl }, owner)
    expect(result).toMatchObject({
      ok: true,
      snapshot: { status: 'ready', candidates: [] },
    })
    sessionId = (result as { snapshot: { sessionId: string } }).snapshot
      .sessionId
    expect(command.mock.calls.map((call) => call[1])).toEqual([
      'Network.enable',
      'Page.getFrameTree',
    ])
    // The user refreshes the target. The extension neither reloads nor replays a request.
    manager.tabUpdated(8, { status: 'loading', url: targetUrl })
    event({ tabId: 8 }, 'Network.requestWillBeSent', {
      requestId: 'document',
      frameId: 'root',
      loaderId: 'doc2',
      type: 'Document',
      request: { url: targetUrl },
    })
    event({ tabId: 8 }, 'Network.requestWillBeSent', {
      requestId: 'shared-request',
      frameId: 'root',
      loaderId: 'doc2',
      documentURL: targetUrl,
      type: entry.resourceType,
      request: {
        url: entry.observation.url,
        method: entry.observation.method,
        headers: entry.observation.requestHeaders,
        ...(entry.observation.requestBody
          ? { postData: entry.observation.requestBody }
          : {}),
      },
    })
    event({ tabId: 8 }, 'Network.responseReceived', {
      requestId: 'shared-request',
      type: entry.resourceType,
      response: {
        status: 200,
        mimeType: 'application/json',
        headers: entry.observation.responseHeaders,
      },
    })
    await finish('shared-request')
    expect(await snapshot()).toMatchObject({
      ok: true,
      snapshot: {
        candidates: [
          {
            method: entry.observation.method,
            path: entry.candidate.path,
            configurable: true,
            samples: [
              {
                triggerPath: entry.observedTriggerPaths[0],
                response: entry.candidate.samples[0].response,
              },
            ],
          },
        ],
      },
    })
    expect(
      command.mock.calls.some((call) => /reload|navigate/i.test(call[1])),
    ).toBe(false)
  })
  it('opens and attaches exactly its new tab, enables bounded network and never reloads', async () => {
    await begin()
    expect(create).toHaveBeenCalledWith({ url: start.targetUrl, active: true })
    expect(attach).toHaveBeenCalledWith({ tabId: 8 }, '1.3')
    expect(command.mock.calls.map((c) => c[1])).toEqual([
      'Network.enable',
      'Page.getFrameTree',
    ])
    expect(command.mock.calls[0][2]).toMatchObject({
      maxResourceBufferSize: 65536,
      maxPostDataSize: 65536,
    })
    request()
    await finish()
    expect(await snapshot()).toMatchObject({
      ok: true,
      snapshot: {
        candidates: [
          { configurable: true, samples: [{ response: { balance: 42 } }] },
        ],
      },
    })
    expect(JSON.stringify(await snapshot())).not.toContain('SECRET_COOKIE')
    await vi.advanceTimersByTimeAsync(300)
    expect(changed).toHaveBeenLastCalledWith(7, {
      type: 'discovery-snapshot-changed',
    })
  })
  it('decodes base64 UTF8 JSON, not a second gzip layer', async () => {
    await begin()
    body = {
      body: btoa(
        String.fromCharCode(
          ...new TextEncoder().encode('{"label":"中文","balance":42}'),
        ),
      ),
      base64Encoded: true,
    }
    request()
    await finish()
    expect(await snapshot()).toMatchObject({
      snapshot: {
        candidates: [
          { samples: [{ response: { label: '中文', balance: 42 } }] },
        ],
      },
    })
  })
  it('ignores iframe, other-tab and worker events', async () => {
    await begin()
    request('iframe', { frameId: 'child' })
    await finish('iframe')
    request('worker', { frameId: undefined })
    await finish('worker')
    event({ tabId: 9 }, 'Network.requestWillBeSent', {
      requestId: 'other',
      type: 'Fetch',
    })
    expect(await snapshot()).toMatchObject({ snapshot: { candidates: [] } })
  })
  it('keeps attachment on same-origin refresh and drops old document completions', async () => {
    await begin()
    request('old')
    manager.tabUpdated(8, { status: 'loading', url: start.targetUrl })
    event({ tabId: 8 }, 'Network.requestWillBeSent', {
      requestId: 'document',
      frameId: 'root',
      loaderId: 'doc2',
      type: 'Document',
      request: { url: start.targetUrl },
    })
    await finish('old')
    request('fresh', { loaderId: 'doc2' })
    await finish('fresh')
    expect(await snapshot()).toMatchObject({
      snapshot: { candidates: [{ occurrences: 1 }] },
    })
    expect(detach).not.toHaveBeenCalled()
  })

  it('accepts fresh requests when the document event precedes tabs loading', async () => {
    await begin()
    event({ tabId: 8 }, 'Network.requestWillBeSent', {
      requestId: 'document',
      frameId: 'root',
      loaderId: 'doc2',
      type: 'Document',
      request: { url: start.targetUrl },
    })
    manager.tabUpdated(8, { status: 'loading', url: start.targetUrl })
    request('fresh', { loaderId: 'doc2' })
    await finish('fresh')
    expect(await snapshot()).toMatchObject({
      snapshot: { candidates: [{ occurrences: 1 }] },
    })
  })
  it('stop erases data and ignores late response promises', async () => {
    await begin()
    request()
    let resolve: (value: unknown) => void = () => undefined
    command.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    event({ tabId: 8 }, 'Network.loadingFinished', { requestId: 'req1' })
    await manager.handle(
      { type: 'stop-discovery', correlationId: 'stop-1234', sessionId },
      owner,
    )
    resolve({ body: '{"secret":"late"}', base64Encoded: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(await snapshot()).toMatchObject({
      ok: true,
      snapshot: { status: 'stopped', candidates: [] },
    })
    expect(detach).toHaveBeenCalledWith({ tabId: 8 })
  })
  it.each([
    'owner-reload',
    'owner-close',
    'target-close',
    'target-origin',
    'detach',
    'timeout',
  ])('terminates and erases on %s', async (reason) => {
    await begin()
    request()
    await finish()
    if (reason === 'owner-reload') manager.tabUpdated(7, { status: 'loading' })
    if (reason === 'owner-close') manager.tabRemoved(7)
    if (reason === 'target-close') manager.tabRemoved(8)
    if (reason === 'target-origin')
      manager.tabUpdated(8, { url: 'https://elsewhere.example' })
    if (reason === 'detach') detached({ tabId: 8 })
    if (reason === 'timeout') await vi.advanceTimersByTimeAsync(15 * 60 * 1000)
    expect(await snapshot()).toMatchObject({
      snapshot: { candidates: [], status: 'stopped' },
    })
  })
  it('enforces exact RPC, extension, origin, frame, document, tab and session ownership', async () => {
    expect(await manager.handle({ ...start, tabId: 9 }, owner)).toMatchObject({
      ok: false,
      code: 'INVALID_REQUEST',
    })
    await begin()
    for (const sender of [
      { ...owner, id: 'other' },
      { ...owner, frameId: 1 },
      { ...owner, url: 'https://evil.example' },
      { ...owner, tab: { ...owner.tab, id: 99 } },
      { ...owner, documentId: 'other' },
    ])
      expect(await snapshot(sender)).toMatchObject({
        ok: false,
        code: 'INVALID_SENDER',
      })
    expect(await snapshot(owner, 'wrong-session')).toMatchObject({
      ok: false,
      code: 'NO_SESSION',
    })
  })
  it('maps attach failure to safe code and never detaches an unowned debugger', async () => {
    attach.mockRejectedValue(new Error('secret diagnostic'))
    expect(await manager.handle(start, owner)).toMatchObject({
      ok: false,
      code: 'ATTACH_FAILED',
    })
    expect(detach).not.toHaveBeenCalled()
  })
  it('erases at pending-ID quota and times out unresolved requests', async () => {
    await begin()
    request('timed-out')
    await vi.advanceTimersByTimeAsync(31000)
    await finish('timed-out')
    expect(await snapshot()).toMatchObject({ snapshot: { candidates: [] } })
    for (let i = 0; i < 65; i++) request(`pending-${i}`)
    expect(await snapshot()).toMatchObject({
      snapshot: { status: 'stopped', reason: 'QUOTA_REACHED', candidates: [] },
    })
  })
  it('drops duplicate finish events and safely records unavailable body failures', async () => {
    await begin()
    request()
    command.mockRejectedValueOnce(new Error('private-body-error'))
    await finish()
    await finish()
    expect(await snapshot()).toMatchObject({
      snapshot: {
        candidates: [
          {
            occurrences: 1,
            configurable: false,
            samples: [{ responseBodyState: 'unavailable' }],
          },
        ],
      },
    })
    expect(JSON.stringify(await snapshot())).not.toContain('private-body-error')
  })
  it.each([
    'decoded',
    'identity-length',
  ])('does not fetch an already oversized JSON body: %s', async (kind) => {
    await begin()
    request()
    if (kind === 'decoded') {
      event({ tabId: 8 }, 'Network.dataReceived', {
        requestId: 'req1',
        dataLength: 40000,
        encodedDataLength: 100,
      })
      event({ tabId: 8 }, 'Network.dataReceived', {
        requestId: 'req1',
        dataLength: 30000,
        encodedDataLength: 100,
      })
    } else
      event({ tabId: 8 }, 'Network.responseReceived', {
        requestId: 'req1',
        response: {
          mimeType: 'application/json',
          status: 200,
          headers: { 'Content-Length': '70000' },
        },
      })
    await finish()
    expect(
      command.mock.calls.some((call) => call[1] === 'Network.getResponseBody'),
    ).toBe(false)
    expect(await snapshot()).toMatchObject({
      snapshot: {
        candidates: [
          {
            configurable: false,
            samples: [
              {
                response: null,
                responseBodyState: 'oversize',
                responseBodyBytes: 65537,
              },
            ],
          },
        ],
      },
    })
  })
  it('does not confuse gzip encoded content-length with decoded body length', async () => {
    await begin()
    request()
    event({ tabId: 8 }, 'Network.responseReceived', {
      requestId: 'req1',
      response: {
        mimeType: 'application/json',
        status: 200,
        headers: { 'Content-Encoding': 'gzip', 'Content-Length': '70000' },
      },
    })
    event({ tabId: 8 }, 'Network.dataReceived', {
      requestId: 'req1',
      dataLength: 14,
      encodedDataLength: 70000,
    })
    await finish()
    expect(
      command.mock.calls.some((call) => call[1] === 'Network.getResponseBody'),
    ).toBe(true)
    expect(await snapshot()).toMatchObject({
      snapshot: { candidates: [{ samples: [{ response: { balance: 42 } }] }] },
    })
  })
  it('ignores late byte-count events after refresh and stop', async () => {
    await begin()
    request('old')
    manager.tabUpdated(8, { status: 'loading', url: start.targetUrl })
    event({ tabId: 8 }, 'Network.dataReceived', {
      requestId: 'old',
      dataLength: 70000,
    })
    request('fresh')
    await finish('fresh')
    expect(await snapshot()).toMatchObject({
      snapshot: { candidates: [{ samples: [{ responseBodyState: 'json' }] }] },
    })
    await manager.handle(
      { type: 'stop-discovery', correlationId: 'stop-1234', sessionId },
      owner,
    )
    event({ tabId: 8 }, 'Network.dataReceived', {
      requestId: 'fresh',
      dataLength: 70000,
    })
    await finish('old')
    expect(await snapshot()).toMatchObject({
      snapshot: { status: 'stopped', candidates: [] },
    })
  })
  it('invalidates attach completion after owner closes, detaching only once', async () => {
    let release: () => void = () => undefined
    attach.mockImplementationOnce(
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    const starting = manager.handle(start, owner)
    await vi.advanceTimersByTimeAsync(0)
    manager.tabRemoved(7)
    release()
    expect(await starting).toMatchObject({ ok: false, code: 'TAB_CLOSED' })
    expect(detach).toHaveBeenCalledTimes(1)
    expect(command).not.toHaveBeenCalled()
  })
  it('waits for the initially blank target to navigate before reporting ready', async () => {
    command.mockImplementation(async (_target, method) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'root', loaderId: 'doc1', url: 'about:blank' },
            },
          }
        : {},
    )
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => ({
      id,
      url: id === 7 ? owner.url : 'about:blank',
      pendingUrl: start.targetUrl,
    })) as never)
    const starting = manager.handle(start, owner)
    await vi.advanceTimersByTimeAsync(0)
    expect(await Promise.race([starting, Promise.resolve('waiting')])).toBe(
      'waiting',
    )
    command.mockImplementation(async (_target, method) =>
      method === 'Page.getFrameTree'
        ? {
            frameTree: {
              frame: { id: 'root', loaderId: 'doc1', url: start.targetUrl },
            },
          }
        : {},
    )
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => ({
      id,
      url: id === 7 ? owner.url : start.targetUrl,
    })) as never)
    manager.tabUpdated(8, { status: 'complete', url: start.targetUrl })
    expect(await starting).toMatchObject({
      ok: true,
      snapshot: { status: 'ready' },
    })
  })
  it('uses debugger root metadata without target tabs URL permission and records actual SPA document path', async () => {
    vi.spyOn(chrome.tabs, 'get').mockImplementation((async (id: number) => ({
      id,
      ...(id === 7 ? { url: owner.url } : {}),
    })) as never)
    await begin()
    request('spa', { documentURL: 'https://client.example/history/orders' })
    await finish('spa')
    expect(await snapshot()).toMatchObject({
      snapshot: {
        candidates: [
          {
            samples: [
              { triggerPath: '/history/orders', triggerPathSafe: true },
            ],
          },
        ],
      },
    })
  })
  it('new worker instance does not restore data or scan unrelated debugger targets', async () => {
    expect(await snapshot(owner, 'previous-worker-session')).toMatchObject({
      ok: false,
      code: 'NO_SESSION',
    })
    expect(detach).not.toHaveBeenCalled()
  })

  it('returns setup failure at 30s even if attach never resolves, and allows a fresh session', async () => {
    attach.mockImplementationOnce(() => new Promise(() => undefined))
    const starting = manager.handle(start, owner)
    await vi.advanceTimersByTimeAsync(31000)
    expect(
      await Promise.race([starting, Promise.resolve('still-pending')]),
    ).toMatchObject({ ok: false, code: 'ATTACH_FAILED' })
    await begin()
  })

  it('erases raw pending objects held by late response promises on stop', async () => {
    await begin()
    request()
    const pending = (
      manager as unknown as { session: { pending: Map<string, unknown> } }
    ).session.pending.get('req1')
    expect(JSON.stringify(pending)).toContain('SECRET_COOKIE')
    await manager.handle(
      { type: 'stop-discovery', correlationId: 'stop-1234', sessionId },
      owner,
    )
    expect(JSON.stringify(pending)).not.toContain('SECRET_COOKIE')
    expect(JSON.stringify(pending)).not.toContain('api.example')
  })
})
