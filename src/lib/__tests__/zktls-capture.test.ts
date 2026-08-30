import { describe, expect, test, vi } from 'vitest'
import {
  CaptureSession,
  clearCapturedRequest,
  createCaptureBinding,
  normalizePathQuery,
} from '@/lib/zktls/capture'
import type { V4Connector } from '@/lib/zktls/interpreter'
import {
  htmlBetweenDisclosureRanges,
  interpretCaptured,
  validateConnector,
} from '@/lib/zktls/interpreter'
import { activateCaptureTab } from '@/lib/zktls/runtime'
import { v4PublicRequestDetails } from '@/lib/zktls/v4-disclosure'

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

const matcherProvider = {
  ...provider,
  interpreter_version: 3,
  revision: 3,
  request: {
    method: 'GET',
    matcher: {
      path: { kind: 'prefix', value: '/users/' },
      query: {
        required: { from: '2026-01-01' },
        optional: { format: 'compact' },
        capture: { account: 'username' },
      },
      resource_types: ['xmlhttprequest', 'fetch'],
    },
    headers: provider.request.headers,
    secret_headers: provider.request.secret_headers,
    max_sent_data: 8192,
    max_recv_data: 65536,
    replay_safety_evidence: 'The matched profile GET is read-only.',
  },
} as const

const postProvider = {
  ...matcherProvider,
  revision: 4,
  request: {
    ...matcherProvider.request,
    method: 'POST',
    matcher: {
      ...matcherProvider.request.matcher,
      query: { required: { from: '2026-01-01' }, optional: {}, capture: {} },
    },
    body: {
      content_type: 'application/json',
      required: { action: 'profile' },
      capture: { account: 'account' },
    },
    replay_safety_evidence: 'The POST is explicitly idempotent and read-only.',
  },
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

function matcherSession(): CaptureSession {
  return new CaptureSession(
    createCaptureBinding({
      tabId: 7,
      frameId: 0,
      sessionId: 'session1',
      providerId: matcherProvider.connector_id,
      revision: matcherProvider.revision,
      origin: matcherProvider.origin,
      matcher: matcherProvider.request.matcher,
      secretHeaders: ['cookie'],
    }),
  )
}

function postSession(
  contentType:
    | 'application/json'
    | 'application/x-www-form-urlencoded' = 'application/json',
): CaptureSession {
  const request =
    contentType === 'application/json'
      ? postProvider.request
      : {
          ...postProvider.request,
          body: {
            content_type: 'application/x-www-form-urlencoded' as const,
            required: { action: 'profile' },
            capture: { account: 'account' },
          },
        }
  return new CaptureSession(
    createCaptureBinding({
      tabId: 7,
      frameId: 0,
      sessionId: 'session1',
      providerId: postProvider.connector_id,
      revision: postProvider.revision,
      origin: postProvider.origin,
      method: 'POST',
      matcher: request.matcher,
      bodyMatcher: request.body,
      secretHeaders: ['cookie'],
    }),
  )
}

const v4BindingConnector = {
  interpreter_version: 4,
  connector_id: 'example-account-binding',
  revision: 1,
  disabled: false,
  expires_at: '2030-01-01T00:00:00.000Z',
  purpose: 'ACCOUNT_BINDING',
  account_binding: {
    providerKey: 'example',
    accountVariable: 'accountId',
    walletOutput: 'wallet',
    addressType: 'EVM',
  },
  page_origin: 'https://app.example.com',
  origin: 'https://api.example.com',
  request: {
    method: 'POST',
    matcher: {
      path: { kind: 'exact', value: '/v1/account' },
      query: {
        required: { network: 'mainnet', account: { $var: 'queryAccount' } },
        optional: {},
        capture: {},
      },
      resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
    },
    body: {
      operation: 'account',
      input: { account: { $var: 'accountId' }, day: { $var: 'periodKey' } },
    },
    content_type: 'application/json',
    replay: 'EXACT_CAPTURE',
    semantics: 'READ_ONLY_QUERY',
    secret_headers: [],
    max_sent_data: 8192,
    max_recv_data: 4096,
  },
  variables: [
    {
      name: 'accountId',
      scalarType: 'STRING',
      source: {
        kind: 'CAPTURED_REQUEST',
        location: 'BODY_JSON',
        selector: '$.input.account',
      },
    },
    {
      name: 'periodKey',
      scalarType: 'STRING',
      source: { kind: 'SESSION', field: 'periodKey' },
    },
    {
      name: 'queryAccount',
      scalarType: 'STRING',
      source: {
        kind: 'CAPTURED_REQUEST',
        location: 'QUERY',
        selector: 'account',
      },
    },
  ],
  resolved_variables: {
    periodKey: { type: 'STRING', value: '2026-08-21' },
  },
  response_format: 'json',
  response_status: 200,
  disclosure: {
    key_paths: ['$.wallet'],
    scalar_paths: ['$.wallet'],
    collection_paths: [],
    max_elements: 200,
  },
  pipelines: [
    {
      output: 'wallet',
      sourcePath: '$.wallet',
      cast: 'STRING',
    },
  ],
  verifier_profile_id: 'lighthouse-v1',
} as const satisfies V4Connector

function v4Session(
  publicHeaders?: Readonly<Record<string, string>>,
): CaptureSession {
  return new CaptureSession(
    createCaptureBinding({
      interpreterVersion: 4,
      maxSentData: 8192,
      tabId: 7,
      frameId: 0,
      sessionId: 'session-v4',
      providerId: v4BindingConnector.connector_id,
      revision: v4BindingConnector.revision,
      pageOrigin: v4BindingConnector.page_origin,
      targetOrigin: v4BindingConnector.origin,
      method: 'POST',
      matcher: v4BindingConnector.request.matcher,
      template: v4BindingConnector.request.body,
      contentType: v4BindingConnector.request.content_type,
      publicHeaders,
      variables: v4BindingConnector.variables,
      resolvedVariables: v4BindingConnector.resolved_variables,
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
    expect(validateConnector(postProvider).interpreter_version).toBe(3)
    expect(() =>
      validateConnector({
        ...postProvider,
        request: { ...postProvider.request, body: undefined },
      }),
    ).toThrow('request.body is invalid')
    expect(() =>
      validateConnector({
        ...postProvider,
        request: { ...postProvider.request, replay_safety_evidence: '' },
      }),
    ).toThrow('replay_safety_evidence')
  })

  test('matches a canonical v3 query and captures named slots', () => {
    const capture = matcherSession()
    for (const url of [
      'https://github.com/users/octocat?from=2026-01-01&username=octocat&extra=1',
      'https://github.com/users/octocat?from=2026-01-01&username=octocat&username=other',
      'https://github.com/users/octocat?from=2026-01-01&username=octocat',
    ]) {
      capture.observe({
        requestId: `ignored-${url.length}`,
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url,
        type: url.includes('&extra=') ? 'xmlhttprequest' : 'main_frame',
        requestHeaders: [{ name: 'Cookie', value: 'unrelated' }],
      })
    }
    capture.observe({
      requestId: 'matched',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://github.com/users/octocat?from=2026-01-01&username=octocat',
      type: 'fetch',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    })
    expect(capture.take()).toEqual({
      path: '/users/octocat?from=2026-01-01&username=octocat',
      slots: { account: 'octocat' },
      resource_type: 'fetch',
      secrets: { cookie: 'private' },
    })
  })

  test('rejects ambiguous v3 matcher schemas and duplicate provider matches', () => {
    expect(() =>
      validateConnector({
        ...matcherProvider,
        request: {
          ...matcherProvider.request,
          matcher: {
            ...matcherProvider.request.matcher,
            path: { kind: 'exact', value: '/users?from=2026-01-01' },
          },
        },
      }),
    ).toThrow('request.matcher.path')
    expect(() =>
      validateConnector({
        ...matcherProvider,
        request: {
          ...matcherProvider.request,
          matcher: {
            ...matcherProvider.request.matcher,
            query: {
              ...matcherProvider.request.matcher.query,
              optional: { from: '2026-01-01' },
            },
          },
        },
      }),
    ).toThrow('request.matcher.query is ambiguous')
    const capture = matcherSession()
    const details = {
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://github.com/users/octocat?from=2026-01-01&username=octocat',
      type: 'xmlhttprequest',
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    }
    capture.observe({ ...details, requestId: 'first' })
    expect(() => capture.observe({ ...details, requestId: 'second' })).toThrow(
      'capture already completed',
    )
  })

  test('canonicalizes JSON POST bodies and captures body slots', () => {
    const capture = postSession()
    const raw = new TextEncoder().encode(
      '{"action":"profile","account":"octocat"}',
    )
    capture.observeBody({
      requestId: 'post-json',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestBody: { raw: [{ bytes: raw.buffer }] },
    })
    capture.observe({
      requestId: 'post-json',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestHeaders: [
        { name: 'Content-Type', value: 'application/json; charset=UTF-8' },
        { name: 'Cookie', value: 'private' },
      ],
    })
    expect(capture.take()).toEqual({
      method: 'POST',
      path: '/users/octocat?from=2026-01-01',
      body: '{"account":"octocat","action":"profile"}',
      content_type: 'application/json',
      slots: { account: 'octocat' },
      resource_type: 'fetch',
      secrets: { cookie: 'private' },
    })
  })

  test('canonicalizes form POST bodies and rejects duplicate form keys', () => {
    const capture = postSession('application/x-www-form-urlencoded')
    capture.observeBody({
      requestId: 'post-form',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestBody: { formData: { account: ['octocat'], action: ['profile'] } },
    })
    capture.observe({
      requestId: 'post-form',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestHeaders: [
        { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
        { name: 'Cookie', value: 'private' },
      ],
    })
    expect(capture.take()).toMatchObject({
      body: 'account=octocat&action=profile',
      content_type: 'application/x-www-form-urlencoded',
      slots: { account: 'octocat' },
    })

    const duplicate = postSession('application/x-www-form-urlencoded')
    duplicate.observeBody({
      requestId: 'duplicate-form',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestBody: {
        formData: { account: ['octocat', 'other'], action: ['profile'] },
      },
    })
    expect(() =>
      duplicate.observe({
        requestId: 'duplicate-form',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url: 'https://github.com/users/octocat?from=2026-01-01',
        type: 'fetch',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
          { name: 'Cookie', value: 'private' },
        ],
      }),
    ).toThrow('duplicate fields')
  })

  test('rejects unsupported POST content types and duplicate POST matches', () => {
    const capture = postSession()
    const raw = new TextEncoder().encode(
      '{"action":"profile","account":"octocat"}',
    )
    capture.observeBody({
      requestId: 'bad-type',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestBody: { raw: [{ bytes: raw.buffer }] },
    })
    expect(() =>
      capture.observe({
        requestId: 'bad-type',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url: 'https://github.com/users/octocat?from=2026-01-01',
        type: 'fetch',
        requestHeaders: [
          { name: 'Content-Type', value: 'multipart/form-data' },
          { name: 'Cookie', value: 'private' },
        ],
      }),
    ).toThrow('content type is unsupported')

    const duplicate = postSession()
    duplicate.observeBody({
      requestId: 'first-post',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://github.com/users/octocat?from=2026-01-01',
      type: 'fetch',
      requestBody: { raw: [{ bytes: raw.buffer }] },
    })
    expect(() =>
      duplicate.observeBody({
        requestId: 'second-post',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url: 'https://github.com/users/octocat?from=2026-01-01',
        type: 'fetch',
        requestBody: { raw: [{ bytes: raw.buffer }] },
      }),
    ).toThrow('capture already completed')
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

  test('clears captured secrets and bodies at the send-request boundary', () => {
    const secrets = { cookie: 'private' }
    const slots = { account: 'octocat' }
    const captured = {
      method: 'POST' as const,
      path: provider.request.path,
      body: '{"account":"octocat"}',
      content_type: 'application/json' as const,
      secrets,
      slots,
    }
    clearCapturedRequest(captured)
    expect(secrets).toEqual({ cookie: '' })
    expect(captured.secrets).toEqual({})
    expect(slots).toEqual({ account: '' })
    expect(captured.slots).toEqual({})
    expect(captured.path).toBe('')
    expect(captured.body).toBe('')
    expect(captured.content_type).toBeUndefined()
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

  test('keeps legacy redirects limited to an existing candidate', () => {
    const capture = session()
    expect(
      capture.redirect(
        {
          requestId: 'legacy-unrelated',
          tabId: 99,
          frameId: 8,
          method: 'POST',
          url: 'https://unrelated.example.com/start',
          redirectUrl: `https://github.com${provider.request.path}`,
        },
        'captured request redirected',
      ),
    ).toBe(false)
    capture.observe({
      requestId: 'legacy-unrelated',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: `https://github.com${provider.request.path}`,
      requestHeaders: [{ name: 'Cookie', value: 'private' }],
    })
    expect(capture.take()).toMatchObject({ path: provider.request.path })
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
        request_target: provider.request.path,
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

describe('zkTLS v4 capture', () => {
  const url =
    'https://api.example.com/v1/account?network=mainnet&account=acct-query'
  const chunks = [
    new TextEncoder().encode(
      '{"operation":"account","input":{"account":"acct-',
    ),
    new TextEncoder().encode('body","day":"2026-08-21"}}'),
  ]

  function observePost(capture: CaptureSession, requestId = 'v4-post') {
    capture.observeBody({
      requestId,
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    capture.observe({
      requestId,
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    })
  }

  function jsonBodyOfSize(size: number): string {
    const encoder = new TextEncoder()
    for (let count = 1; count <= 16; count += 1) {
      const values = Array.from({ length: count }, () => '')
      const empty = JSON.stringify({ padding: values })
      let remaining = size - encoder.encode(empty).length
      if (remaining < 0 || remaining > count * 1024) continue
      for (let index = 0; index < values.length; index += 1) {
        const length = Math.min(remaining, 1024)
        values[index] = 'x'.repeat(length)
        remaining -= length
      }
      const result = JSON.stringify({ padding: values })
      if (encoder.encode(result).length === size) return result
    }
    throw new Error(`cannot create ${size} JSON bytes`)
  }

  function sizedV4Session(body: string): CaptureSession {
    return new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: 'sized-v4',
        providerId: 'sized-v4',
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'POST',
        matcher: {
          path: { kind: 'exact', value: '/v1/size' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        template: JSON.parse(body),
        contentType: 'application/json',
        variables: [],
        resolvedVariables: {},
      }),
    )
  }

  function observeSized(capture: CaptureSession, body: string): void {
    const details = {
      requestId: 'sized',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://api.example.com/v1/size',
      type: 'fetch',
      initiator: 'https://app.example.com',
    }
    capture.observeBody({
      ...details,
      requestBody: {
        raw: [{ bytes: new TextEncoder().encode(body).buffer }],
      },
    })
    capture.observe({
      ...details,
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    })
  }

  test('rejects an 8,184-byte body whose complete replay exceeds 8 KiB', () => {
    const body = jsonBodyOfSize(8184)
    expect(new TextEncoder().encode(body)).toHaveLength(8184)

    expect(() => observeSized(sizedV4Session(body), body)).toThrow('sent limit')
  })

  test('accepts the largest body whose complete replay is exactly 8 KiB', () => {
    let bodySize = 0
    for (let size = 1; size <= 8192; size += 1) {
      if (
        v4PublicRequestDetails({
          origin: 'https://api.example.com',
          method: 'POST',
          path: '/v1/size',
          body: 'x'.repeat(size),
          contentType: 'application/json',
        }).sentByteLength === 8192
      ) {
        bodySize = size
        break
      }
    }
    const body = jsonBodyOfSize(bodySize)
    const capture = sizedV4Session(body)

    observeSized(capture, body)

    expect(
      v4PublicRequestDetails({
        origin: 'https://api.example.com',
        method: 'POST',
        path: '/v1/size',
        body,
        contentType: 'application/json',
      }).sentByteLength,
    ).toBe(8192)
    expect(capture.take()).toMatchObject({ body })
  })

  function redirectDetails(requestId: string) {
    return {
      requestId,
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://start.example.com/unsigned',
      redirectUrl: url,
      type: 'fetch',
      initiator: 'https://app.example.com',
    }
  }

  test.each([
    undefined,
    'https://evil.example.com',
    'null',
  ])('rejects a matching target request with initiator %s', (initiator) => {
    const capture = v4Session()
    expect(() =>
      capture.observeBody({
        requestId: 'bad-initiator',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator,
        requestBody: {
          raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
        },
      }),
    ).toThrow('initiator')
  })

  test('rejects ALLOW_EXTRA in a direct V4 capture binding', () => {
    expect(() =>
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: 'allow-extra',
        providerId: 'allow-extra',
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'POST',
        matcher: {
          path: { kind: 'exact', value: '/v1/query' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        template: { $object: { mode: 'ALLOW_EXTRA', fields: {} } },
        contentType: 'application/json',
        variables: [],
        resolvedVariables: {},
      }),
    ).toThrow('capture matcher is invalid')
  })

  test('rejects a main-frame target without the exact page initiator', () => {
    const capture = v4Session()
    expect(() =>
      capture.observeBody({
        requestId: 'main-frame-initiator',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'main_frame',
        requestBody: {
          raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
        },
      }),
    ).toThrow('initiator')
  })

  test('discards credential and custom header candidates without reading values', () => {
    for (const name of [
      'Cookie',
      'Authorization',
      'Proxy-Authorization',
      'X-Api-Key',
      'X-Api-Token',
      'X-CSRF-Token',
      'X-XSRF-Token',
      'X-Session-Id',
      'X-Custom-Auth',
      'X-Signature',
      'X-Key',
      'X-Benign-Metadata',
    ]) {
      const capture = v4Session()
      capture.observeBody({
        requestId: name,
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestBody: {
          raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
        },
      })
      let valueReads = 0
      const credential = { name } as { name: string; value?: string }
      Object.defineProperty(credential, 'value', {
        get() {
          valueReads += 1
          return 'private'
        },
      })
      expect(() =>
        capture.observe({
          requestId: name,
          tabId: 7,
          frameId: 0,
          method: 'POST',
          url,
          type: 'fetch',
          initiator: 'https://app.example.com',
          requestHeaders: [
            { name: 'Content-Type', value: 'application/json' },
            credential,
          ],
        }),
      ).not.toThrow()
      expect(valueReads).toBe(0)
      expect(() => capture.take()).toThrow('no provider request was captured')
    }
  })

  test('captures a later safe request after discarding an unsafe candidate', () => {
    const capture = v4Session()
    capture.observeBody({
      requestId: 'unsafe',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    let valueReads = 0
    const forbidden = { name: 'X-App-Client-Type' } as {
      name: string
      value?: string
    }
    Object.defineProperty(forbidden, 'value', {
      get() {
        valueReads += 1
        return 'private'
      },
    })
    expect(() =>
      capture.observe({
        requestId: 'unsafe',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          forbidden,
        ],
      }),
    ).not.toThrow()
    expect(valueReads).toBe(0)
    expect(() => capture.take()).toThrow('no provider request was captured')

    observePost(capture, 'safe')

    expect(capture.take()).toMatchObject({
      method: 'POST',
      path: url.slice('https://api.example.com'.length),
      body: '{"operation":"account","input":{"account":"acct-body","day":"2026-08-21"}}',
      secrets: {},
    })
  })

  test('ignores a mismatched V4 body and captures a later exact request', () => {
    const capture = v4Session()
    const unrelated = new TextEncoder().encode(
      '{"operation":"background","input":{"account":"acct-body","day":"2026-08-21"}}',
    )
    capture.observeBody({
      requestId: 'unrelated-body',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: { raw: [{ bytes: unrelated.buffer }] },
    })
    expect(() =>
      capture.observe({
        requestId: 'unrelated-body',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
      }),
    ).not.toThrow()

    expect(() => capture.take()).toThrow('no provider request was captured')

    observePost(capture, 'exact-body')

    expect(capture.take()).toMatchObject({
      method: 'POST',
      body: '{"operation":"account","input":{"account":"acct-body","day":"2026-08-21"}}',
      secrets: {},
    })
  })

  test('captures an exact signed public request header', () => {
    const capture = v4Session({ 'x-client-type': 'public' })
    capture.observeBody({
      requestId: 'public-header',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    capture.observe({
      requestId: 'public-header',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        { name: 'X-Client-Type', value: 'public' },
      ],
    })

    expect(capture.take()).toMatchObject({ method: 'POST' })
  })

  test.each([
    null,
    'other',
    'PUBLIC',
  ])('rejects signed public request header value %s', (value) => {
    const capture = v4Session({ 'x-client-type': 'public' })
    capture.observeBody({
      requestId: 'bad-public-header',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    expect(() =>
      capture.observe({
        requestId: 'bad-public-header',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          ...(value === null ? [] : [{ name: 'X-Client-Type', value }]),
        ],
      }),
    ).not.toThrow()
    expect(() => capture.take()).toThrow('no provider request was captured')
  })

  test.each([
    'Sec-Fetch-Authorization',
    'Sec-Fetch-Unknown',
    'Sec-CH-Api-Key',
    'Sec-CH-UA-Full-Version-List',
  ])('discards unsupported client metadata header %s without reading it', (name) => {
    const capture = v4Session()
    capture.observeBody({
      requestId: name,
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    let valueReads = 0
    const header = { name } as { name: string; value?: string }
    Object.defineProperty(header, 'value', {
      get() {
        valueReads += 1
        return 'private'
      },
    })
    expect(() =>
      capture.observe({
        requestId: name,
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          header,
        ],
      }),
    ).not.toThrow()
    expect(valueReads).toBe(0)
    expect(() => capture.take()).toThrow('no provider request was captured')
  })

  test.each([
    undefined,
    null,
  ])('rejects a V4 POST when requestHeaders is %s', (requestHeaders) => {
    const capture = v4Session()
    capture.observeBody({
      requestId: 'missing-post-headers',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    expect(() =>
      capture.observe({
        requestId: 'missing-post-headers',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: requestHeaders as never,
      }),
    ).toThrow('request headers')
  })

  test('allows a same-origin V4 page and public target', () => {
    const binding = createCaptureBinding({
      interpreterVersion: 4,
      maxSentData: 8192,
      tabId: 7,
      frameId: 0,
      sessionId: 'same-origin',
      providerId: 'same-origin',
      revision: 1,
      pageOrigin: 'https://app.example.com',
      targetOrigin: 'https://app.example.com',
      method: 'GET',
      matcher: {
        path: { kind: 'exact', value: '/v1/get' },
        query: { required: {}, optional: {}, capture: {} },
        resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
      },
      variables: [],
      resolvedVariables: {},
    })
    const capture = new CaptureSession(binding)
    capture.observe({
      requestId: 'same-origin',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://app.example.com/v1/get',
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [],
    })
    expect(capture.take()).toMatchObject({ path: '/v1/get' })
  })

  test.each([
    ['https://app.example.com:443', 'https://api.example.com'],
    ['https://app.example.com:8443', 'https://api.example.com'],
    ['https://app.example.com', 'https://api.example.com:8443'],
  ])('rejects a direct V4 capture binding with non-default origins %s / %s', (pageOrigin, targetOrigin) => {
    expect(() =>
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: 'non-default-port',
        providerId: 'non-default-port',
        revision: 1,
        pageOrigin,
        targetOrigin,
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/v1/get' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        variables: [],
        resolvedVariables: {},
      }),
    ).toThrow('capture matcher is invalid')
  })

  test.each([
    undefined,
    null,
  ])('rejects a V4 GET when requestHeaders is %s', (requestHeaders) => {
    const binding = createCaptureBinding({
      interpreterVersion: 4,
      maxSentData: 8192,
      tabId: 7,
      frameId: 0,
      sessionId: 'missing-get-headers',
      providerId: 'missing-get-headers',
      revision: 1,
      pageOrigin: 'https://app.example.com',
      targetOrigin: 'https://app.example.com',
      method: 'GET',
      matcher: {
        path: { kind: 'exact', value: '/v1/get' },
        query: { required: {}, optional: {}, capture: {} },
        resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
      },
      variables: [],
      resolvedVariables: {},
    })
    expect(() =>
      new CaptureSession(binding).observe({
        requestId: 'missing-get-headers',
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: 'https://app.example.com/v1/get',
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: requestHeaders as never,
      }),
    ).toThrow('request headers')
  })

  test('denies a redirected ID before it reaches the signed target', () => {
    const capture = v4Session()
    expect(
      capture.redirect(
        redirectDetails('redirected'),
        'captured request redirected',
      ),
    ).toBe(false)
    expect(() => observePost(capture, 'redirected')).toThrow('redirected')
  })

  test('denies a signed request after redirecting it', () => {
    const capture = v4Session()
    observePost(capture, 'signed-redirect')
    expect(
      capture.redirect(
        {
          ...redirectDetails('signed-redirect'),
          url,
          redirectUrl: 'https://other.example.com/result',
        },
        'captured request redirected',
      ),
    ).toBe(true)
    expect(() => capture.take()).toThrow('captured request redirected')
  })

  test('allows request ID reuse after terminal cleanup or session clear', () => {
    const afterComplete = v4Session()
    afterComplete.redirect(
      redirectDetails('reused'),
      'captured request redirected',
    )
    expect(afterComplete.completes('reused')).toBe(false)
    observePost(afterComplete, 'reused')
    expect(afterComplete.take()).toMatchObject({ method: 'POST' })

    const afterError = v4Session()
    afterError.redirect(
      redirectDetails('reused'),
      'captured request redirected',
    )
    expect(afterError.reject('reused', 'captured request failed')).toBe(false)
    observePost(afterError, 'reused')
    expect(afterError.take()).toMatchObject({ method: 'POST' })

    const afterClear = v4Session()
    afterClear.redirect(
      redirectDetails('reused'),
      'captured request redirected',
    )
    afterClear.clear()
    observePost(afterClear, 'reused')
    expect(afterClear.take()).toMatchObject({ method: 'POST' })
  })

  test('fails closed when too many redirected request IDs are pending', () => {
    const capture = v4Session()
    for (let index = 0; index < 64; index += 1)
      expect(
        capture.redirect(
          redirectDetails(`redirect-${index}`),
          'captured request redirected',
        ),
      ).toBe(false)
    expect(
      capture.redirect(
        redirectDetails('redirect-overflow'),
        'captured request redirected',
      ),
    ).toBe(true)
    expect(() => capture.take()).toThrow('too many redirects')
  })

  test('counts only redirects that match the signed query and resource type', () => {
    const capture = v4Session()
    for (let index = 0; index < 64; index += 1) {
      expect(
        capture.redirect(
          {
            ...redirectDetails(`wrong-query-${index}`),
            redirectUrl:
              'https://api.example.com/v1/account?network=testnet&account=acct-query',
          },
          'captured request redirected',
        ),
      ).toBe(false)
      expect(
        capture.redirect(
          {
            ...redirectDetails(`wrong-type-${index}`),
            type: 'image',
          },
          'captured request redirected',
        ),
      ).toBe(false)
    }
    for (let index = 0; index < 64; index += 1)
      expect(
        capture.redirect(
          redirectDetails(`exact-${index}`),
          'captured request redirected',
        ),
      ).toBe(false)
    expect(
      capture.redirect(
        redirectDetails('exact-overflow'),
        'captured request redirected',
      ),
    ).toBe(true)
    expect(() => capture.take()).toThrow('too many redirects')
  })

  test('tracks an exact signed matcher reached through a relative redirect', () => {
    const capture = v4Session()
    expect(
      capture.redirect(
        {
          ...redirectDetails('relative'),
          url: 'https://api.example.com/unsigned',
          redirectUrl: '/v1/account?network=mainnet&account=acct-query',
        },
        'captured request redirected',
      ),
    ).toBe(false)
    expect(() => observePost(capture, 'relative')).toThrow('redirected')
  })

  test('ignores 65 redirects from another tab', () => {
    const capture = v4Session()
    for (let index = 0; index < 65; index += 1)
      expect(
        capture.redirect(
          { ...redirectDetails(`cross-tab-${index}`), tabId: 8 },
          'captured request redirected',
        ),
      ).toBe(false)
    observePost(capture)
    expect(capture.take()).toMatchObject({ method: 'POST' })
  })

  test('ignores redirects with an evil initiator or unrelated destination', () => {
    const capture = v4Session()
    for (let index = 0; index < 65; index += 1) {
      expect(
        capture.redirect(
          {
            ...redirectDetails(`evil-${index}`),
            initiator: 'https://evil.example.com',
          },
          'captured request redirected',
        ),
      ).toBe(false)
      expect(
        capture.redirect(
          {
            ...redirectDetails(`unrelated-${index}`),
            redirectUrl: 'https://other.example.com/result',
          },
          'captured request redirected',
        ),
      ).toBe(false)
    }
    observePost(capture)
    expect(capture.take()).toMatchObject({ method: 'POST' })
  })

  test('allows ordinary browser metadata headers on a public JSON request', () => {
    const capture = v4Session()
    let metadataValueReads = 0
    const accept = { name: 'Accept' } as { name: string; value?: string }
    Object.defineProperty(accept, 'value', {
      get() {
        metadataValueReads += 1
        return 'application/json'
      },
    })
    capture.observeBody({
      requestId: 'browser-headers',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: {
        raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
      },
    })
    capture.observe({
      requestId: 'browser-headers',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [
        { name: 'Content-Type', value: 'application/json' },
        accept,
        { name: 'Origin', value: 'https://app.example.com' },
        { name: 'Referer', value: 'https://app.example.com/' },
        { name: 'User-Agent', value: 'Chrome' },
        { name: 'Sec-CH-UA', value: 'Chromium' },
        { name: 'Sec-CH-UA-Mobile', value: '?0' },
        { name: 'Sec-CH-UA-Platform', value: 'macOS' },
        { name: 'Sec-Fetch-Dest', value: 'empty' },
        { name: 'Sec-Fetch-Mode', value: 'cors' },
        { name: 'Sec-Fetch-Site', value: 'cross-site' },
        { name: 'Sec-Fetch-User', value: '?1' },
      ],
    })
    expect(capture.take()).toMatchObject({
      body: expect.stringContaining('acct-body'),
    })
    expect(metadataValueReads).toBe(0)
  })

  test('rejects a V4 form binding before observing the network', () => {
    expect(() =>
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: 'form-rejected',
        providerId: 'form-rejected',
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'POST',
        matcher: {
          path: { kind: 'exact', value: '/v1/form' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        template: { account: { $var: 'accountId' } },
        contentType: 'application/x-www-form-urlencoded' as never,
        variables: [
          {
            name: 'accountId',
            scalarType: 'STRING',
            source: {
              kind: 'CAPTURED_REQUEST',
              location: 'BODY_FORM',
              selector: 'account',
            },
          },
        ],
        resolvedVariables: {},
      }),
    ).toThrow('content type')
  })

  test('matches a cross-origin nested POST and joins all raw chunks exactly', () => {
    const capture = v4Session()
    capture.observeBody({
      requestId: 'page-origin-is-not-target',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://app.example.com/v1/account?network=mainnet&account=nope',
      type: 'fetch',
      requestBody: { raw: [{ bytes: chunks[0].buffer }] },
    })
    observePost(capture)
    const taken = capture.take()
    expect(taken).toMatchObject({
      method: 'POST',
      path: '/v1/account?network=mainnet&account=acct-query',
      body: '{"operation":"account","input":{"account":"acct-body","day":"2026-08-21"}}',
      content_type: 'application/json',
      capturedVariables: {
        accountId: 'acct-body',
        queryAccount: 'acct-query',
      },
      semanticCanonical:
        '{"input":{"account":"acct-body","day":"2026-08-21"},"operation":"account"}',
      resource_type: 'fetch',
      secrets: {},
    })
    expect(taken).not.toHaveProperty('credentials')
    expect(taken).not.toHaveProperty('secretHeaders')
    clearCapturedRequest(taken)
    expect(taken.body).toBe('')
    expect(taken.semanticCanonical).toBe('')
    expect(taken.capturedVariables).toEqual({})
    expect(Object.getPrototypeOf(taken.capturedVariables!)).toBeNull()
  })

  test('requires exact target, method, path, query, content type, and resource type', () => {
    for (const change of [
      { url: url.replace('api.example.com', 'other.example.com') },
      { url: url.replace('/v1/account', '/v1/other') },
      { url: url.replace('network=mainnet', 'network=testnet') },
      { url: `${url}&extra=1` },
      { method: 'GET' },
      { type: 'other' },
    ]) {
      const capture = v4Session()
      capture.observeBody({
        requestId: 'no-match',
        tabId: 7,
        frameId: 0,
        method: change.method ?? 'POST',
        url: change.url ?? url,
        type: change.type ?? 'fetch',
        initiator: 'https://app.example.com',
        requestBody: { raw: chunks.map((chunk) => ({ bytes: chunk.buffer })) },
      })
      expect(() => capture.take()).toThrow('no provider request')
    }

    const wrongContentType = v4Session()
    wrongContentType.observeBody({
      requestId: 'wrong-type',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: { raw: chunks.map((chunk) => ({ bytes: chunk.buffer })) },
    })
    expect(() =>
      wrongContentType.observe({
        requestId: 'wrong-type',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/json; charset=utf-8' },
        ],
      }),
    ).toThrow('content type')
  })

  test('fails closed for zero, multiple, body-less POST, and GET body candidates', () => {
    expect(() => v4Session().take()).toThrow('no provider request')

    const duplicate = v4Session()
    duplicate.observeBody({
      requestId: 'first',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestBody: { raw: chunks.map((chunk) => ({ bytes: chunk.buffer })) },
    })
    expect(() =>
      duplicate.observeBody({
        requestId: 'second',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestBody: { raw: chunks.map((chunk) => ({ bytes: chunk.buffer })) },
      }),
    ).toThrow('capture already completed')

    expect(() =>
      v4Session().observeBody({
        requestId: 'body-less',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
      }),
    ).toThrow('POST body')

    const get = new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: 'get-v4',
        providerId: 'get-v4',
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/v1/get' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        variables: [],
        resolvedVariables: {},
      }),
    )
    expect(() =>
      get.observeBody({
        requestId: 'get-body',
        tabId: 7,
        frameId: 0,
        method: 'GET',
        url: 'https://api.example.com/v1/get',
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestBody: {
          raw: [{ bytes: new TextEncoder().encode('{}').buffer }],
        },
      }),
    ).toThrow('GET request body')
  })

  test('clears V4 transient body, digest, and variables on reject and clear', () => {
    const rejected = v4Session()
    observePost(rejected, 'rejected')
    expect(rejected.reject('rejected', 'network failed')).toBe(true)
    expect(() => rejected.take()).toThrow('network failed')

    const cleared = v4Session()
    observePost(cleared, 'cleared')
    cleared.clear()
    expect(() => cleared.take()).toThrow('no provider request')
  })

  test('captures a V4 GET query variable without request credentials', () => {
    const capture = new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: 'get-query-v4',
        providerId: 'get-query-v4',
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/v1/get' },
          query: {
            required: { account: { $var: 'accountId' } },
            optional: {},
            capture: {},
          },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        variables: [
          {
            name: 'accountId',
            scalarType: 'STRING',
            source: {
              kind: 'CAPTURED_REQUEST',
              location: 'QUERY',
              selector: 'account',
            },
          },
        ],
        resolvedVariables: {},
      }),
    )
    capture.observe({
      requestId: 'get-query',
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://api.example.com/v1/get?account=acct-get',
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [],
    })
    expect(capture.take()).toEqual({
      path: '/v1/get?account=acct-get',
      capturedVariables: { accountId: 'acct-get' },
      resource_type: 'fetch',
      secrets: {},
    })
  })

  test.each([
    'constructor',
    'toString',
    'valueOf',
  ])('captures the own QUERY variable %s without prototype lookup', (name) => {
    const capture = new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
        maxSentData: 8192,
        tabId: 7,
        frameId: 0,
        sessionId: `query-${name}`,
        providerId: `query-${name}`,
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/v1/get' },
          query: {
            required: { account: { $var: name } },
            optional: {},
            capture: {},
          },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        variables: [
          {
            name,
            scalarType: 'STRING',
            source: {
              kind: 'CAPTURED_REQUEST',
              location: 'QUERY',
              selector: 'account',
            },
          },
        ],
        resolvedVariables: {},
      }),
    )
    capture.observe({
      requestId: `query-${name}`,
      tabId: 7,
      frameId: 0,
      method: 'GET',
      url: 'https://api.example.com/v1/get?account=own-value',
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [],
    })
    const variables = capture.take().capturedVariables!
    expect(Object.getPrototypeOf(variables)).toBeNull()
    expect(Object.hasOwn(variables, name)).toBe(true)
    expect(variables[name]).toBe('own-value')
  })
})
