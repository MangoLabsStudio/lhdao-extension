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

function v4Session(): CaptureSession {
  return new CaptureSession(
    createCaptureBinding({
      interpreterVersion: 4,
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
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    })
  }

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
      }),
    ).toThrow('POST body')

    const get = new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
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

  test('captures a raw form POST with fixed repeated fields', () => {
    const capture = new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
        tabId: 7,
        frameId: 0,
        sessionId: 'form-v4',
        providerId: 'form-v4',
        revision: 1,
        pageOrigin: 'https://app.example.com',
        targetOrigin: 'https://api.example.com',
        method: 'POST',
        matcher: {
          path: { kind: 'exact', value: '/v1/form' },
          query: {
            required: { network: 'mainnet' },
            optional: {},
            capture: {},
          },
          resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
        },
        template: {
          account: { $var: 'accountId' },
          day: { $var: 'periodKey' },
          tags: ['one', 'two'],
        },
        contentType: 'application/x-www-form-urlencoded',
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
          {
            name: 'periodKey',
            scalarType: 'STRING',
            source: { kind: 'SESSION', field: 'periodKey' },
          },
        ],
        resolvedVariables: {
          periodKey: { type: 'STRING', value: '2026-08-21' },
        },
      }),
    )
    const exactBody = 'day=2026-08-21&account=acct%2Dform&tags=one&tags=two'
    const bytes = new TextEncoder().encode(exactBody)
    capture.observeBody({
      requestId: 'form',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://api.example.com/v1/form?network=mainnet',
      type: 'xmlhttprequest',
      requestBody: {
        raw: [
          { bytes: bytes.slice(0, 20).buffer },
          { bytes: bytes.slice(20).buffer },
        ],
      },
    })
    capture.observe({
      requestId: 'form',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://api.example.com/v1/form?network=mainnet',
      type: 'xmlhttprequest',
      requestHeaders: [
        {
          name: 'Content-Type',
          value: 'application/x-www-form-urlencoded',
        },
      ],
    })
    expect(capture.take()).toMatchObject({
      body: exactBody,
      capturedVariables: { accountId: 'acct-form' },
      semanticCanonical: 'account=acct-form&day=2026-08-21&tags=one&tags=two',
    })
  })

  test('captures a V4 GET query variable without request credentials', () => {
    const capture = new CaptureSession(
      createCaptureBinding({
        interpreterVersion: 4,
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
      requestHeaders: [],
    })
    expect(capture.take()).toEqual({
      path: '/v1/get?account=acct-get',
      capturedVariables: { accountId: 'acct-get' },
      resource_type: 'fetch',
      secrets: {},
    })
  })
})
