import { describe, expect, test, vi } from 'vitest'
import {
  CaptureSession,
  clearCapturedRequest,
  createCaptureBinding,
  normalizePathQuery,
} from '@/lib/zktls/capture'
import {
  htmlBetweenDisclosureRanges,
  interpretCaptured,
  validateConnector,
} from '@/lib/zktls/interpreter'
import { activateCaptureTab } from '@/lib/zktls/runtime'

const provider = {
  interpreter_version: 2,
  connector_id: 'github-contributions',
  revision: 2,
  disabled: false,
  expires_at: '2030-01-01T00:00:00.000Z',
  origin: 'https://github.com',
  request: {
    method: 'GET',
    path: '/users/octocat/contributions?from=2026-01-01&to=2026-12-31',
    headers: {
      accept: 'text/fragment+html',
      'x-requested-with': 'XMLHttpRequest',
    },
    secret_headers: ['cookie'],
    max_sent_data: 8192,
    max_recv_data: 65536,
    replay_safety_evidence: 'GitHub contribution profile GET is read-only.',
  },
  response_format: 'html',
  response_status: 200,
  extraction: {
    kind: 'html_between',
    prefix: '<span data-count="',
    suffix: '"></span>',
    max_bytes: 16,
  },
  verifier_profile_id: 'lighthouse-v1',
} as const

function session(): CaptureSession {
  return new CaptureSession(
    createCaptureBinding({
      tabId: 7,
      frameId: 0,
      sessionId: 'session1',
      providerId: provider.connector_id,
      revision: provider.revision,
      origin: provider.origin,
      path: provider.request.path,
      secretHeaders: ['cookie'],
    }),
  )
}

describe('zkTLS v2 capture', () => {
  test('ignores unrelated GETs and fails on a duplicate exact match', () => {
    const capture = session()
    expect(() =>
      capture.observe({
        requestId: 'unrelated',
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: 'https://github.com/notifications',
        requestHeaders: [{ name: 'Cookie', value: 'unrelated' }],
      }),
    ).not.toThrow()
    expect(() =>
      capture.observe({
        requestId: 'cross-origin',
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: 'https://example.com/anything',
        requestHeaders: [{ name: 'Cookie', value: 'unrelated' }],
      }),
    ).not.toThrow()
    capture.observe({
      requestId: 'r1',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: `https://github.com${provider.request.path}`,
      requestHeaders: [{ name: 'Cookie', value: 'user_session=private' }],
    })
    expect(capture.completes('r1')).toBe(true)
    expect(() =>
      capture.observe({
        requestId: 'r2',
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: `https://github.com${provider.request.path}`,
        requestHeaders: [{ name: 'Cookie', value: 'second' }],
      }),
    ).toThrow('capture already completed')
    expect(capture.take()).toEqual({
      path: provider.request.path,
      secrets: { cookie: 'user_session=private' },
    })
    expect(() => capture.take()).toThrow('no provider request was captured')
  })

  test('rejects noncanonical configured paths and requires replay evidence', () => {
    expect(() => normalizePathQuery('/x?a=1&a=2')).toThrow('duplicate query')
    expect(() => normalizePathQuery('/x?name=%7e')).toThrow(
      'noncanonical encoding',
    )
    expect(() => normalizePathQuery('/x#fragment')).toThrow('fragment')
    expect(() =>
      validateConnector({
        ...provider,
        request: { ...provider.request, replay_safety_evidence: '' },
      }),
    ).toThrow('replay_safety_evidence')
    expect(() =>
      validateConnector({
        ...provider,
        request: { ...provider.request, secret_headers: [] },
      }),
    ).toThrow('secret_headers')
  })

  test('activates the provider tab without navigating to the signed path', async () => {
    const original = chrome.tabs.update
    const update = vi.fn().mockResolvedValue({ id: 7 })
    Object.defineProperty(chrome.tabs, 'update', {
      configurable: true,
      value: update,
    })
    try {
      await activateCaptureTab(7)
      expect(update).toHaveBeenCalledWith(7, { active: true })
    } finally {
      Object.defineProperty(chrome.tabs, 'update', {
        configurable: true,
        value: original,
      })
    }
  })

  test('clears captured secrets at the send-request boundary', () => {
    const secrets = { cookie: 'private' }
    const captured = { path: provider.request.path, secrets }
    clearCapturedRequest(captured)
    expect(secrets).toEqual({ cookie: '' })
    expect(captured.secrets).toEqual({})
  })

  test('rejects redirects and retries before any secret can be replayed', () => {
    const capture = session()
    capture.observe({
      requestId: 'r1',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: `https://github.com${provider.request.path}`,
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    })
    expect(capture.reject('r1', 'captured request redirected')).toBe(true)
    expect(() => capture.take()).toThrow('captured request redirected')
    expect(() =>
      capture.observe({
        requestId: 'r2',
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: `https://github.com${provider.request.path}`,
        requestHeaders: [{ name: 'Cookie', value: 'retry' }],
      }),
    ).toThrow('capture already completed')
  })

  test('uses a complete bounded HTML window and retains v1 as a supported schema', () => {
    const config = validateConnector(provider)
    if (config.interpreter_version !== 2) throw new Error('wrong provider')
    const response = '<span data-count="12"></span>'
    expect(htmlBetweenDisclosureRanges(config, response)).toMatchObject({
      claim: '12',
    })
    expect(
      interpretCaptured(config, {
        response,
        status: 200,
        now: '2026-08-16T00:00:00.000Z',
      }),
    ).toEqual({
      request_target: provider.request.path,
      status: '200',
      claim: '12',
    })
    expect(() =>
      htmlBetweenDisclosureRanges(config, `${response}${response}`),
    ).toThrow('prefix was ambiguous')
    expect(
      validateConnector({
        interpreter_version: 1,
        connector_id: 'v1',
        revision: 1,
        disabled: false,
        expires_at: '2030-01-01T00:00:00.000Z',
        origin: 'https://github.com',
        identity_source: {
          kind: 'html_meta',
          name: 'user-login',
          max_bytes: 64,
        },
        request: {
          method: 'GET',
          path_template: '/me/${' + 'identity}',
          headers: { accept: 'application/json' },
          max_sent_data: 8192,
          max_recv_data: 65536,
        },
        response_format: 'json',
        response_status: 200,
        extraction: { kind: 'json_pointer', pointer: '/login' },
        verifier_profile_id: 'lighthouse-v1',
      }).interpreter_version,
    ).toBe(1)
  })
})
