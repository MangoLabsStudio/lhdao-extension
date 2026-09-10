import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CapturedRequest } from '../zktls/capture'
import { validateConnector } from '../zktls/interpreter'
import { ZKTLS_PROFILE } from '../zktls/profile'
import type { ProofReviewSnapshot } from '../zktls/review'
import * as reviewCapture from '../zktls/review-capture'
import {
  handleZkTlsProof,
  proveZkTlsSession,
  registerZkTlsRuntime,
  type ZkTlsRunRequest,
} from '../zktls/runtime'
import * as signedConfig from '../zktls/signed-config'

const fixture = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-field-difference.json', 'utf8'),
)
const wallet = '0x1111111111111111111111111111111111111111'
const pageUrl = 'https://app.example.com/history'
const now = Date.parse('2026-09-10T08:00:00.000Z')

function eventBus() {
  const listeners = new Set<(...args: unknown[]) => void>()
  return {
    addListener: vi.fn((listener: (...args: unknown[]) => void) =>
      listeners.add(listener),
    ),
    removeListener: vi.fn((listener: (...args: unknown[]) => void) =>
      listeners.delete(listener),
    ),
    emit: (...args: unknown[]) => {
      for (const listener of listeners) listener(...args)
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
  const config = validateConnector(structuredClone(fixture.connector))
  const ticket: signedConfig.Ticket = {
    schema: 1,
    session_id: 'session-1',
    connector_id: config.connector_id,
    revision: 1,
    interpreter_version: 4,
    config_digest: fixture.configDigest,
    issued_at: new Date(now - 60_000).toISOString(),
    expires_at: config.expires_at,
    nonce: 'n1',
  }
  vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
    config,
    ticket,
    configEnvelope: {
      key_id: 'k1',
      config,
      config_digest: ticket.config_digest,
      signature: 's'.repeat(86),
    },
    ticketEnvelope: { key_id: 'k1', ticket, signature: 't'.repeat(86) },
  })
  Object.assign(ZKTLS_PROFILE, {
    enabled: true,
    apiEndpoint: 'https://service.lhdao.top/zktls/config',
    verifierProfileId: 'lighthouse-v1',
  })
  const headers = eventBus()
  const complete = eventBus()
  const sent: unknown[] = []
  const sendMessage = vi.fn(async (message: unknown) => {
    sent.push(structuredClone(message))
    return { status: 'submitted' }
  })
  const getContexts = vi.fn(async () => [])
  const createDocument = vi.fn(async () => {})
  const tabUpdate = vi.fn(async () => ({ id: 7, url: pageUrl }))
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      getContexts,
      sendMessage,
      onMessage: eventBus(),
    },
    permissions: { contains: vi.fn(async () => true), onRemoved: eventBus() },
    offscreen: { createDocument },
    tabs: {
      query: vi.fn(async () => [{ id: 7, url: pageUrl }]),
      get: vi.fn(async () => ({ id: 7, url: pageUrl })),
      update: tabUpdate,
      create: vi.fn(async () => ({ id: 7, url: pageUrl })),
      onUpdated: eventBus(),
    },
    webRequest: {
      onBeforeRequest: eventBus(),
      onBeforeSendHeaders: headers,
      onBeforeRedirect: eventBus(),
      onErrorOccurred: eventBus(),
      onCompleted: complete,
    },
    scripting: { executeScript: vi.fn(async () => []) },
  })
  const captured: CapturedRequest = {
    method: 'GET',
    path: '/v1/events?account=acct-1',
    secrets: {},
    capturedVariables: {},
  }
  const originalCaptured = structuredClone(captured)
  const invalid = deferred<string>()
  const observer = {
    read: Promise.resolve({
      captured,
      responseBody: Buffer.from(fixture.decodedBase64url, 'base64url').toString(
        'utf8',
      ),
      contentType: 'application/json',
      status: 200,
      pageUrl,
    }),
    invalidated: invalid.promise,
    assertCurrent: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  }
  const observe = vi
    .spyOn(reviewCapture, 'observeProofReview')
    .mockImplementation(async (input) => {
      input.onReady()
      return observer
    })
  const consent = deferred<boolean>()
  const controller = new AbortController()
  const review = {
    signal: controller.signal,
    onReady: vi.fn(),
    confirm: vi.fn((_snapshot: ProofReviewSnapshot) => consent.promise),
    assertOwner: vi.fn(async () => {}),
    onProving: vi.fn(),
  }
  const request: ZkTlsRunRequest = {
    sessionId: ticket.session_id,
    connectorId: config.connector_id,
    correlationId: 'correlation-1',
    reviewContext: {
      tabId: 7,
      expectedWallet: wallet,
      title: 'Deposit amount',
      ownerSessionId: 'owner-1',
      configVersion: 4,
    },
    review,
  }
  return {
    config,
    ticket,
    captured,
    originalCaptured,
    sent,
    getContexts,
    createDocument,
    sendMessage,
    tabUpdate,
    headers,
    complete,
    observer,
    observe,
    consent,
    controller,
    invalid,
    review,
    request,
  }
}

describe('actual zkTLS runtime review consent boundary', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not create an offscreen worker or prove before confirmation, then sends the exact capture once', async () => {
    const h = setup()
    const result = proveZkTlsSession(h.request)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.review.confirm).toHaveBeenCalledOnce()
    expect(h.review.confirm.mock.calls[0][0]).toMatchObject({
      canConfirm: true,
      account: { status: 'matched' },
    })
    expect(h.getContexts).not.toHaveBeenCalled()
    expect(h.createDocument).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
    h.consent.resolve(true)
    expect(await result).toMatchObject({ status: 'submitted' })
    expect(h.sendMessage).toHaveBeenCalledOnce()
    expect(h.sent[0]).toMatchObject({
      type: 'zktls-offscreen-prove',
      captured: h.originalCaptured,
    })
    expect(h.review.onProving).toHaveBeenCalledOnce()
    expect(h.observer.dispose).toHaveBeenCalled()
  })

  it.each([
    'declined',
    'aborted',
    'owner-changed',
    'page-changed',
    'invalidated',
  ])('does not prove when %s after reading', async (reason) => {
    const h = setup()
    const result = proveZkTlsSession(h.request)
    await vi.advanceTimersByTimeAsync(0)
    if (reason === 'aborted') h.controller.abort()
    if (reason === 'owner-changed')
      h.review.assertOwner.mockRejectedValue(new Error('REVIEW_OWNER_CHANGED'))
    if (reason === 'page-changed')
      h.observer.assertCurrent.mockRejectedValue(
        new Error('REVIEW_PAGE_CHANGED'),
      )
    if (reason === 'invalidated')
      h.invalid.resolve('REVIEW_ACCOUNT_OR_REQUEST_CHANGED')
    else h.consent.resolve(reason !== 'declined')
    expect(await result).not.toMatchObject({ status: 'submitted' })
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(h.getContexts).not.toHaveBeenCalled()
  })

  it('rejects an expired local snapshot even while the signed ticket remains valid', async () => {
    const h = setup()
    const result = proveZkTlsSession(h.request)
    await vi.advanceTimersByTimeAsync(0)
    vi.setSystemTime(now + 60_001)
    h.consent.resolve(true)
    const settled = await result
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(settled).not.toMatchObject({ status: 'submitted' })
  })

  it('rejects callback approval of an unknown wallet preview', async () => {
    const h = setup()
    h.request.reviewContext!.expectedWallet = null
    const result = proveZkTlsSession(h.request)
    await vi.advanceTimersByTimeAsync(0)
    h.consent.resolve(true)
    const settled = await result
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(settled).not.toMatchObject({ status: 'submitted' })
  })

  it('fails closed with reviewContext but no review callback', async () => {
    const h = setup()
    delete h.request.review
    expect(await proveZkTlsSession(h.request)).toMatchObject({
      status: 'unsupported',
      code: 'REVIEW_UNSUPPORTED',
    })
    expect(h.observe).not.toHaveBeenCalled()
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('rechecks ownership after offscreen preparation before submitting a proof', async () => {
    const h = setup()
    h.createDocument.mockImplementation(async () => {
      h.review.assertOwner.mockRejectedValue(new Error('REVIEW_OWNER_CHANGED'))
    })
    const result = proveZkTlsSession(h.request)
    await vi.advanceTimersByTimeAsync(0)
    h.consent.resolve(true)
    expect(await result).not.toMatchObject({ status: 'submitted' })
    expect(h.sendMessage).not.toHaveBeenCalled()
  })

  it('fails closed for public V4 zktls-prove without trusted reviewContext', async () => {
    const h = setup()
    registerZkTlsRuntime()
    const result = handleZkTlsProof(
      {
        type: 'zktls-prove',
        sessionId: 'session-1',
        connectorId: h.config.connector_id,
        correlationId: 'public-1',
      },
      {
        id: 'extension-id',
        frameId: 0,
        url: 'https://app.lhdao.top/verify/session-1',
      },
    )
    await vi.advanceTimersByTimeAsync(0)
    // Exercise the legacy capture path if it is incorrectly entered.
    const details = {
      requestId: 'network-1',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://api.example.com/v1/events?account=acct-1',
      initiator: 'https://app.example.com',
      type: 'fetch',
      requestHeaders: [],
    }
    h.headers.emit(details)
    h.complete.emit({ requestId: 'network-1' })
    const settled = await result
    expect(h.sendMessage).not.toHaveBeenCalled()
    expect(settled).not.toMatchObject({ status: 'submitted' })
  })
})
