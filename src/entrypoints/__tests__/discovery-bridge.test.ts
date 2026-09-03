import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CandidateStore } from '@/lib/zktls/discovery/candidate-store'
import content from '../web-presence.content'

describe('discovery page to background bridge', () => {
  let cleanup: () => void
  let runtime: (message: unknown, sender: chrome.runtime.MessageSender) => void
  const origin = 'https://app.lhdao.top'
  const request = {
    channel: 'product-experience-v1',
    type: 'start-discovery',
    correlationId: 'start-12345',
    targetUrl: 'https://client.example/app',
  }
  const response = {
    type: 'discovery-result',
    requestType: 'start-discovery',
    correlationId: request.correlationId,
    ok: true,
    snapshot: {
      schema: 1,
      sessionId: 'session-12345',
      status: 'ready',
      reason: null,
      pageOrigin: 'https://client.example',
      startedAt: 0,
      expiresAt: 900000,
      ...new CandidateStore().snapshot(),
    },
  }
  let send: ReturnType<typeof vi.spyOn>
  let post: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    Object.defineProperty(chrome.runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    send = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async () => response) as never)
    post = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined)
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(
      (listener) => {
        runtime = listener as typeof runtime
      },
    )
    content.main({
      onInvalidated: (fn: () => void) => {
        cleanup = fn
      },
    } as never)
  })
  afterEach(() => {
    cleanup?.()
    vi.restoreAllMocks()
  })
  async function emit(data: unknown, overrides = {}) {
    window.dispatchEvent(
      new MessageEvent('message', {
        source: window,
        origin,
        data,
        ...overrides,
      }),
    )
    await Promise.resolve()
    await Promise.resolve()
  }
  it('forwards only exact requests, correlates responses and makes body-free notifications', async () => {
    await emit(request)
    expect(send).toHaveBeenCalledWith({
      type: 'start-discovery',
      correlationId: request.correlationId,
      targetUrl: request.targetUrl,
    })
    expect(post).toHaveBeenCalledWith(
      { channel: request.channel, ...response },
      origin,
    )
    runtime(
      { type: 'discovery-snapshot-changed', body: 'must-not-forward' },
      { id: 'extension' },
    )
    expect(post).toHaveBeenLastCalledWith(
      { channel: request.channel, type: 'discovery-snapshot-changed' },
      origin,
    )
    await emit({ ...request, tabId: 8 })
    await emit(request, { source: null })
    await emit(request, { origin: 'https://evil.example' })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('does not forward mismatched correlation/session responses or raw errors', async () => {
    send.mockImplementationOnce((async () => ({
      ...response,
      correlationId: 'wrong',
    })) as never)
    await emit(request)
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'product-experience-error',
        error: 'EXTENSION_ERROR',
      }),
      origin,
    )
    send.mockImplementationOnce((async () => ({
      ...response,
      requestType: 'get-discovery-snapshot',
    })) as never)
    await emit({
      channel: request.channel,
      type: 'get-discovery-snapshot',
      correlationId: request.correlationId,
      sessionId: 'wrong-session',
    })
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'product-experience-error',
        error: 'EXTENSION_ERROR',
      }),
      origin,
    )
    send.mockRejectedValueOnce(new Error('SECRET-ERROR'))
    await emit(request)
    expect(JSON.stringify(post.mock.calls)).not.toContain('SECRET-ERROR')
  })
  it('ignores background notifications from another extension', () => {
    const before = post.mock.calls.length
    runtime({ type: 'discovery-snapshot-changed' }, { id: 'other' })
    expect(post.mock.calls.length).toBe(before)
  })
})
