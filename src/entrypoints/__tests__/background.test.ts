import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  type AvailableEngagement,
  ME_QUERY,
  MY_RESERVED_ENGAGEMENTS_QUERY,
} from '@/lib/queries'
import { CaptureSession } from '@/lib/zktls/capture'
import { validateConnector } from '@/lib/zktls/interpreter'
import { ZKTLS_PROFILE } from '@/lib/zktls/profile'
import {
  handleZkTlsProof,
  proveZkTlsSession,
  registerZkTlsRuntime,
} from '@/lib/zktls/runtime'
import * as signedConfig from '@/lib/zktls/signed-config'
import {
  buildActiveCampaignSummaries,
  flattenTasks,
  productZkTlsStartGqlOptions,
  reserveErrorCode,
} from '../background'

beforeEach(() => {
  const removed = chrome.permissions.onRemoved as unknown as {
    addListener(listener: (value: chrome.permissions.Permissions) => void): void
    removeListener(
      listener: (value: chrome.permissions.Permissions) => void,
    ): void
  }
  vi.spyOn(removed, 'addListener').mockImplementation(() => undefined)
  vi.spyOn(removed, 'removeListener').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
  Object.assign(ZKTLS_PROFILE, {
    enabled: false,
    apiEndpoint: null,
    verifierProfileId: null,
  })
  delete (chrome.runtime as unknown as Record<string, unknown>).getContexts
  delete (chrome as unknown as Record<string, unknown>).offscreen
})

const binanceLikeCampaign = {
  id: 'binance-like',
  type: 'ENGAGEMENT',
  platform: 'BINANCE_SQUARE',
  targetUrl: 'https://x.com/legacy/status/123456',
  targetContentId: '1',
  targetAuthorId: 'author-1',
  tweetId: 'legacy-tweet-id',
  targetUsername: null,
  actions: [{ actionType: 'LIKE', baseReward: 1, targetCount: 1 }],
} as unknown as AvailableEngagement

const binanceFollowCampaign = {
  id: 'binance-follow',
  type: 'ENGAGEMENT',
  platform: 'BINANCE_SQUARE',
  targetUrl: null,
  targetContentId: null,
  targetAuthorId: 'author-2',
  tweetId: null,
  targetUsername: 'legacy-user',
  actions: [{ actionType: 'FOLLOW', baseReward: 1, targetCount: 1 }],
} as unknown as AvailableEngagement

describe('X task indexes', () => {
  it('maps server-selected claim denial to a stable user-facing error', () => {
    expect(reserveErrorCode('LIGHTHOUSE_SELECTED_REQUIRED')).toEqual({
      code: 'LIGHTHOUSE_SELECTED_REQUIRED',
      message: '需灯塔严选资格',
    })
  })
  it('routes discovery RPC to an isolated native session and declares Chrome lifetime support', async () => {
    const source = (await import('../background?raw')).default
    expect(source).toContain(
      'new DiscoverySessionManager(new URL(WEB_ENDPOINT).origin)',
    )
    expect(source).toContain('return discovery.handle(req, sender)')
    const manifest = (await import('../../../wxt.config?raw')).default
    expect(manifest).toContain("minimum_chrome_version: '118'")
    expect(manifest).toContain("'debugger'")
  })
  it('rejects Binance campaigns carrying stale X tweet targets', () => {
    expect(buildActiveCampaignSummaries([binanceLikeCampaign])).toEqual([])
    expect(flattenTasks([binanceLikeCampaign], new Set())).toEqual({
      byTweet: {},
      byAuthor: {},
    })
  })

  it('rejects Binance campaigns carrying stale X follow targets', () => {
    expect(flattenTasks([binanceFollowCampaign], new Set())).toEqual({
      byTweet: {},
      byAuthor: {},
    })
  })
})

describe('comment guidance propagation', () => {
  const campaign = (
    id: string,
    commentGuide: string | null,
  ): AvailableEngagement => ({
    ...binanceLikeCampaign,
    id,
    platform: 'X',
    tweetId: '123456',
    commentGuide,
    keywords: ['not a guide'],
    actions: [{ actionType: 'COMMENT_LIKE', baseReward: 1, targetCount: 1 }],
  })

  it('requests commentGuide for both available and reserved orders', () => {
    expect(AVAILABLE_ENGAGEMENTS_QUERY).toContain('commentGuide')
    expect(MY_RESERVED_ENGAGEMENTS_QUERY).toContain('commentGuide')
  })

  it('requests current qualification, selected scope and viewer claim snapshot', () => {
    expect(ME_QUERY).toContain('lighthouseSelected')
    expect(AVAILABLE_ENGAGEMENTS_QUERY).toContain('lighthouseSelectedOnly')
    expect(AVAILABLE_ENGAGEMENTS_QUERY).toContain('myLighthouseSelectedAtClaim')
    expect(MY_RESERVED_ENGAGEMENTS_QUERY).toContain('lighthouseSelectedOnly')
    expect(MY_RESERVED_ENGAGEMENTS_QUERY).toContain(
      'myLighthouseSelectedAtClaim',
    )
  })

  it('preserves selected scope and nullable claim snapshots in task caches', () => {
    const selected = {
      ...campaign('selected', null),
      lighthouseSelectedOnly: true,
      myLighthouseSelectedAtClaim: true,
    } as AvailableEngagement
    const legacy = campaign('legacy', null)
    const rows = flattenTasks(
      [selected, legacy],
      new Set(['selected', 'legacy']),
    ).byTweet['123456']
    expect(rows.find((row) => row.campaignId === 'selected')).toMatchObject({
      lighthouseSelectedOnly: true,
      lighthouseSelectedAtClaim: true,
    })
    const legacyRow = rows.find((row) => row.campaignId === 'legacy')
    expect(legacyRow).not.toHaveProperty('lighthouseSelectedOnly')
    expect(legacyRow).not.toHaveProperty('lighthouseSelectedAtClaim')
  })

  it('preserves full guides by campaign across task indexes and summaries', () => {
    const longGuide = `${'旧订单完整内容不截断'.repeat(8)}\n第二行`
    const orders = [campaign('a', longGuide), campaign('b', '另一个方向')]
    const tasks = flattenTasks(orders, new Set(['a'])).byTweet['123456']
    expect(
      tasks.map((t) => [
        t.campaignId,
        t.commentGuide,
        t.commentGuideStatus,
        t.reserved,
      ]),
    ).toEqual([
      ['a', longGuide, 'ready', true],
      ['b', '另一个方向', 'ready', false],
    ])
    expect(
      buildActiveCampaignSummaries(orders).map((t) => [
        t.campaignId,
        t.commentGuide,
      ]),
    ).toEqual([
      ['a', longGuide],
      ['b', '另一个方向'],
    ])
  })

  it('separates an absent field from a known null and never uses keywords', () => {
    const unknown = campaign('unknown', null)
    delete unknown.commentGuide
    const orders = [campaign('empty', null), unknown]
    expect(
      flattenTasks(orders).byTweet['123456'].map((t) => [
        t.commentGuide,
        t.commentGuideStatus,
      ]),
    ).toEqual([
      [null, 'ready'],
      [undefined, 'unavailable'],
    ])
  })
})

describe('Product zkTLS jobs', () => {
  it('allows slow zkTLS start mutations to finish without widening other requests', () => {
    expect(productZkTlsStartGqlOptions('StartProductZkTlsTestProof')).toEqual({
      operationName: 'StartProductZkTlsTestProof',
      timeoutMs: 30_000,
    })
    expect(productZkTlsStartGqlOptions('StartProductZkTlsProof')).toEqual({
      operationName: 'StartProductZkTlsProof',
      timeoutMs: 30_000,
    })
  })

  it('rejects concurrent direct and page proof jobs without replacing the active job', async () => {
    Object.defineProperty(chrome.runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    let rejectFirst: ((error: Error) => void) | undefined
    const signed = vi
      .spyOn(signedConfig, 'fetchAndVerifySignedConfig')
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirst = reject
          }),
      )
      .mockRejectedValue(new Error('concurrent config fetch'))

    const first = proveZkTlsSession({
      correlationId: 'direct-active',
      sessionId: 'session1',
      connectorId: 'connector1',
    })
    await vi.waitFor(() => expect(signed).toHaveBeenCalledTimes(1))

    await expect(
      handleZkTlsProof(
        {
          type: 'zktls-prove',
          correlationId: 'page-busy',
          sessionId: 'session1',
          connectorId: 'connector1',
        },
        {
          id: 'extension',
          frameId: 0,
          url: 'https://app.lhdao.top/verify/session1',
        },
      ),
    ).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'page-busy',
      status: 'error',
      code: 'ZKTLS_BUSY',
    })
    expect(signed).toHaveBeenCalledTimes(1)

    rejectFirst?.(new Error('finish active request'))
    await expect(first).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'direct-active',
      status: 'error',
      code: 'ZKTLS_SETUP_FAILED',
    })
  })

  it('classifies a real prover permission denial without exposing setup details', async () => {
    Object.defineProperty(chrome.runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    const config = validateConnector({
      interpreter_version: 3,
      connector_id: 'connector1',
      revision: 1,
      disabled: false,
      expires_at: '2030-01-01T00:00:00.000Z',
      origin: 'https://github.com',
      request: {
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/viewer' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['xmlhttprequest'],
        },
        headers: {},
        secret_headers: ['cookie'],
        max_sent_data: 8192,
        max_recv_data: 65536,
        replay_safety_evidence: 'The viewer endpoint is read-only.',
      },
      response_format: 'json',
      response_status: 200,
      extraction: {
        kind: 'regex',
        pattern: '^"volume":(\\d+)$',
        max_bytes: 32,
      },
      verifier_profile_id: 'lighthouse-v1',
    })
    const ticket = {
      schema: 1 as const,
      session_id: 'session1',
      connector_id: 'connector1',
      revision: 1,
      interpreter_version: 3 as const,
      config_digest: 'a'.repeat(64),
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2030-01-01T00:00:00.000Z',
      nonce: 'nonce1',
    }
    const signed = vi
      .spyOn(signedConfig, 'fetchAndVerifySignedConfig')
      .mockResolvedValue({
        config,
        ticket,
        configEnvelope: {
          key_id: 'key1',
          config,
          config_digest: ticket.config_digest,
          signature: 'config-signature',
        },
        ticketEnvelope: {
          key_id: 'key1',
          ticket,
          signature: 'ticket-signature',
        },
      })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    vi.spyOn(chrome.permissions, 'contains').mockImplementation(
      (async () => false) as never,
    )
    const createTab = vi
      .spyOn(chrome.tabs, 'create')
      .mockImplementation((async () => ({ id: 8 })) as never)
    let runtimeListener:
      | ((message: unknown, sender: chrome.runtime.MessageSender) => unknown)
      | undefined
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(
      (listener) => {
        runtimeListener = listener as typeof runtimeListener
      },
    )
    for (const event of [
      chrome.webRequest.onBeforeRequest,
      chrome.webRequest.onBeforeSendHeaders,
      chrome.webRequest.onBeforeRedirect,
      chrome.webRequest.onErrorOccurred,
      chrome.webRequest.onCompleted,
    ]) {
      vi.spyOn(event, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
    }
    registerZkTlsRuntime()

    const proving = proveZkTlsSession({
      correlationId: 'product-denied',
      sessionId: 'session1',
      connectorId: 'connector1',
    })
    await vi.waitFor(() => expect(createTab).toHaveBeenCalledTimes(1))
    const permissionUrl = new URL(
      (createTab.mock.calls[0]?.[0] as { url: string }).url,
    )
    await runtimeListener?.(
      {
        type: 'zktls-permission-result',
        requestId: permissionUrl.searchParams.get('request_id'),
        granted: false,
      },
      {
        id: 'extension',
        url: permissionUrl.href,
      },
    )

    await expect(proving).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'product-denied',
      status: 'error',
      code: 'PERMISSION_DENIED',
    })

    signed.mockRejectedValueOnce(new Error('private setup detail'))
    await expect(
      proveZkTlsSession({
        correlationId: 'product-setup',
        sessionId: 'session1',
        connectorId: 'connector1',
      }),
    ).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'product-setup',
      status: 'error',
      code: 'ZKTLS_SETUP_FAILED',
    })
  })

  it('routes internal jobs and strict page messages through the full prover path', async () => {
    Object.defineProperty(chrome.runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    const config = validateConnector({
      interpreter_version: 3,
      connector_id: 'connector1',
      revision: 1,
      disabled: false,
      expires_at: '2030-01-01T00:00:00.000Z',
      origin: 'https://github.com',
      request: {
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/viewer' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['xmlhttprequest'],
        },
        headers: {},
        secret_headers: ['cookie'],
        max_sent_data: 8192,
        max_recv_data: 65536,
        replay_safety_evidence: 'The viewer endpoint is read-only.',
      },
      response_format: 'json',
      response_status: 200,
      extraction: {
        kind: 'regex',
        pattern: '^"volume":(\\d+)$',
        max_bytes: 32,
      },
      verifier_profile_id: 'lighthouse-v1',
    })
    const ticket = {
      schema: 1 as const,
      session_id: 'session1',
      connector_id: 'connector1',
      revision: 1,
      interpreter_version: 3 as const,
      config_digest: 'a'.repeat(64),
      issued_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2030-01-01T00:00:00.000Z',
      nonce: 'nonce1',
    }
    const signed = vi
      .spyOn(signedConfig, 'fetchAndVerifySignedConfig')
      .mockResolvedValue({
        config,
        ticket,
        configEnvelope: {
          key_id: 'key1',
          config,
          config_digest: ticket.config_digest,
          signature: 'config-signature',
        },
        ticketEnvelope: {
          key_id: 'key1',
          ticket,
          signature: 'ticket-signature',
        },
      })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })

    const permissions = vi
      .spyOn(chrome.permissions, 'contains')
      .mockImplementation((async () => true) as never)
    vi.spyOn(chrome.tabs, 'query').mockImplementation((async () => [
      { id: 7, url: 'https://github.com/viewer' },
    ]) as never)
    const activate = vi
      .spyOn(chrome.tabs, 'update')
      .mockImplementation((async () => ({ id: 7 })) as never)
    const contexts = vi.fn().mockResolvedValue([])
    Object.defineProperty(chrome.runtime, 'getContexts', {
      configurable: true,
      value: contexts,
    })
    const offscreen = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(chrome, 'offscreen', {
      configurable: true,
      value: { createDocument: offscreen },
    })
    const submitted: unknown[] = []
    vi.spyOn(chrome.runtime, 'sendMessage').mockImplementation((async (
      message: unknown,
    ) => {
      submitted.push(structuredClone(message))
      return { status: 'submitted' }
    }) as never)

    let observe: ((details: unknown) => void) | undefined
    let redirect: ((details: unknown) => void) | undefined
    let complete: ((details: unknown) => void) | undefined
    vi.spyOn(
      chrome.webRequest.onBeforeSendHeaders,
      'addListener',
    ).mockImplementation(((listener: (details: unknown) => void) => {
      observe = listener
    }) as never)
    vi.spyOn(chrome.webRequest.onCompleted, 'addListener').mockImplementation(((
      listener: (details: unknown) => void,
    ) => {
      complete = listener
    }) as never)
    vi.spyOn(
      chrome.webRequest.onBeforeRedirect,
      'addListener',
    ).mockImplementation(((listener: (details: unknown) => void) => {
      redirect = listener
    }) as never)
    for (const event of [
      chrome.webRequest.onBeforeRequest,
      chrome.webRequest.onErrorOccurred,
      chrome.runtime.onMessage,
    ]) {
      vi.spyOn(event, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
    }
    registerZkTlsRuntime()

    const request = {
      correlationId: 'product1',
      sessionId: 'session1',
      connectorId: 'connector1',
    }
    const sender = {
      id: 'extension',
      frameId: 0,
      url: 'https://app.lhdao.top/verify/session1',
    } as chrome.runtime.MessageSender

    const redirectedProof = proveZkTlsSession({
      ...request,
      correlationId: 'redirect-before-target',
    })
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(1))
    const redirectedDetails = {
      requestId: 'redirected',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://github.com/viewer',
      redirectUrl: 'https://github.com/login',
      type: 'xmlhttprequest',
      initiator: 'https://github.com',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    }
    observe?.(redirectedDetails)
    const redirectSpy = vi.spyOn(CaptureSession.prototype, 'redirect')
    redirect?.(redirectedDetails)
    expect(redirectSpy).toHaveBeenCalledWith(
      redirectedDetails,
      'captured request redirected',
    )
    complete?.({ requestId: 'redirected' })
    await expect(redirectedProof).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'redirect-before-target',
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    })

    const run = async (
      result: Promise<unknown>,
      requestId: string,
      activationCount: number,
    ) => {
      await vi.waitFor(() =>
        expect(activate).toHaveBeenCalledTimes(activationCount),
      )
      observe?.({
        requestId,
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: 'https://github.com/viewer',
        type: 'xmlhttprequest',
        requestHeaders: [{ name: 'Cookie', value: 'private' }],
      })
      complete?.({ requestId })
      return result
    }
    const pageProof = handleZkTlsProof(
      { type: 'zktls-prove', ...request },
      sender,
    )
    await vi.waitFor(() => expect(activate).toHaveBeenCalledTimes(2))
    const productProof = proveZkTlsSession({
      ...request,
      correlationId: 'product-waits-for-page',
      expiresAt: '2030-01-01T00:00:00.000Z',
    })
    await expect(
      proveZkTlsSession({
        ...request,
        correlationId: 'second-product-waiter',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }),
    ).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'second-product-waiter',
      status: 'error',
      code: 'ZKTLS_BUSY',
    })
    expect(signed).toHaveBeenCalledTimes(2)
    observe?.({
      requestId: 'page',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://github.com/viewer',
      type: 'xmlhttprequest',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    })
    complete?.({ requestId: 'page' })
    const page = await pageProof
    const internal = await run(productProof, 'internal', 3)

    expect(page).toMatchObject({ status: 'submitted' })
    expect(internal).toEqual({
      type: 'zktls-prove-result',
      correlationId: 'product-waits-for-page',
      status: 'submitted',
    })
    expect(internal).not.toHaveProperty('captured')
    expect(internal).not.toHaveProperty('resolved_variables')
    expect(internal).not.toHaveProperty('request_body')
    expect(signed).toHaveBeenCalledTimes(3)
    expect(signed).toHaveBeenNthCalledWith(
      3,
      'https://service.lhdao.top/zktls/config?session_id=session1&connector_id=connector1',
      expect.objectContaining({ local: false }),
    )
    expect(permissions).toHaveBeenCalledTimes(3)
    expect(permissions).toHaveBeenCalledWith({
      origins: ['https://github.com/*'],
    })
    expect(activate).toHaveBeenCalledTimes(3)
    expect(contexts).toHaveBeenCalledTimes(2)
    expect(offscreen).toHaveBeenCalledTimes(2)
    expect(submitted).toHaveLength(2)
    const { correlationId: firstCorrelationId, ...firstSubmitted } =
      submitted[0] as Record<string, unknown>
    const { correlationId: secondCorrelationId, ...secondSubmitted } =
      submitted[1] as Record<string, unknown>
    expect(firstSubmitted).toEqual(secondSubmitted)
    expect([firstCorrelationId, secondCorrelationId]).toEqual([
      'product1',
      'product-waits-for-page',
    ])
    expect(submitted[0]).toMatchObject({
      type: 'zktls-offscreen-prove',
      sessionId: 'session1',
      connectorId: 'connector1',
      captured: {
        path: '/viewer',
        resource_type: 'xmlhttprequest',
      },
    })
    await expect(
      handleZkTlsProof(
        { type: 'zktls-prove', ...request, extraction: '$.private' },
        sender,
      ),
    ).resolves.toBeNull()
  })
})
