import { describe, expect, test, vi } from 'vitest'
import {
  revealConfig,
  sessionRegistrationPayload,
  verifierUrls,
} from '@/entrypoints/zktls-offscreen/worker'
import {
  assertConnectorAvailable,
  canonicalJson,
  configDigest,
  interpret,
  validateConnector,
} from '@/lib/zktls/interpreter'
import {
  parseZkTlsPageRequest,
  ZKTLS_PAGE_CHANNEL,
} from '@/lib/zktls/page-bridge'
import { parseZkTlsRuntimeRequest } from '@/lib/zktls/runtime-request'
import {
  assertTicketAvailable,
  fetchAndVerifySignedConfig,
} from '@/lib/zktls/signed-config'

const connector = {
  interpreter_version: 1,
  connector_id: 'github-login',
  revision: 1,
  disabled: false,
  expires_at: '2030-01-01T00:00:00.000Z',
  origin: 'https://github.com',
  identity_source: { kind: 'html_meta', name: 'user-login', max_bytes: 64 },
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
} as const

const htmlConnector = {
  ...connector,
  request: {
    ...connector.request,
    path_template: '/profile/${' + 'identity}',
    headers: { 'x-requested-with': 'XMLHttpRequest' },
  },
  response_format: 'html',
  extraction: {
    kind: 'html_literal_window',
    start: '<span data-user="',
    end: '"></span>',
    claim: `\${identity}`,
  },
} as const

const ticket = {
  schema: 1,
  session_id: 's1',
  connector_id: 'github-login',
  revision: 1,
  interpreter_version: 1,
  config_digest: 'a'.repeat(64),
  issued_at: '2026-08-15T00:00:00.000Z',
  expires_at: '2030-01-01T00:00:00.000Z',
  nonce: 'n1',
} as const

const configEnvelope = {
  key_id: 'k1',
  config: htmlConnector,
  config_digest: 'a'.repeat(64),
  signature: 's'.repeat(86),
}

const ticketEnvelope = {
  key_id: 'k1',
  ticket,
  signature: 't'.repeat(86),
}

function base64Url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

async function signedEnvelopes(ticketDigest?: string) {
  const config_digest = await configDigest(htmlConnector)
  const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])
  const config_envelope = {
    key_id: 'k1',
    config: htmlConnector,
    config_digest,
    signature: '',
  }
  config_envelope.signature = base64Url(
    await crypto.subtle.sign(
      'Ed25519',
      key.privateKey,
      new TextEncoder().encode(`lighthouse-zktls/config/v1:${config_digest}`),
    ),
  )
  const signedTicket = {
    ...ticket,
    config_digest: ticketDigest ?? config_digest,
  }
  const ticket_envelope = {
    key_id: 'k1',
    ticket: signedTicket,
    signature: base64Url(
      await crypto.subtle.sign(
        'Ed25519',
        key.privateKey,
        new TextEncoder().encode(
          `lighthouse-zktls/session-ticket/v1:${canonicalJson(signedTicket)}`,
        ),
      ),
    ),
  }
  return {
    config_envelope,
    ticket_envelope,
    publicKeys: { k1: await crypto.subtle.exportKey('jwk', key.publicKey) },
  }
}

function v4Connector(): Record<string, unknown> {
  return {
    interpreter_version: 4,
    connector_id: 'product-volume',
    revision: 1,
    disabled: false,
    purpose: 'METRIC',
    expires_at: '2030-01-01T00:00:00.000Z',
    page_origin: 'https://app.example.com',
    origin: 'https://api.example.com',
    request: {
      method: 'POST',
      matcher: {
        path: { kind: 'exact', value: '/v1/volume' },
        query: {
          required: { day: { $var: 'periodKey' } },
          optional: {},
          capture: {},
        },
        resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
      },
      body: {
        operation: 'volume',
        input: {
          account: { $var: 'accountId' },
          options: {
            $object: {
              mode: 'ALLOW_EXTRA',
              fields: { day: { $var: 'periodKey' } },
            },
          },
        },
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
        source: { kind: 'BOUND_ACCOUNT', bindingKey: 'example' },
        constraints: {
          minLength: 1,
          maxLength: 128,
          pattern: 'ACCOUNT_ID',
        },
      },
      {
        name: 'periodKey',
        scalarType: 'STRING',
        source: { kind: 'SESSION', field: 'periodKey' },
        constraints: {
          minLength: 10,
          maxLength: 10,
          pattern: 'ISO_DATE',
        },
      },
    ],
    resolved_variables: {
      accountId: { type: 'STRING', value: 'acct-1' },
      periodKey: { type: 'STRING', value: '2026-08-20' },
    },
    response_format: 'json',
    response_status: 200,
    disclosure: {
      key_paths: ['$.data', '$.data.balance'],
      scalar_paths: ['$.data.balance'],
      collection_paths: [],
      max_elements: 200,
    },
    pipelines: [
      {
        output: 'balance',
        sourcePath: '$.data.balance',
        cast: 'DECIMAL',
        valueUnit: 'USDT',
        outputUnit: 'USDT',
      },
    ],
    verifier_profile_id: 'lighthouse-v1',
  }
}

type MutableV4 = Record<string, unknown> & {
  request: Record<string, unknown> & {
    matcher: Record<string, unknown> & {
      query: Record<string, unknown> & { required: Record<string, unknown> }
    }
  }
  variables: Record<string, unknown>[]
  resolved_variables: Record<string, unknown>
  disclosure: Record<string, unknown>
  pipelines: Record<string, unknown>[]
}

function testRecord(value: unknown): Record<string, unknown> {
  return value as Record<string, unknown>
}

function cloneV4(): MutableV4 {
  return structuredClone(v4Connector()) as MutableV4
}

describe('zkTLS strict boundaries', () => {
  test('parses the exact public full-disclosure V4 connector', async () => {
    const config = v4Connector()

    expect(validateConnector(config)).toMatchObject({
      interpreter_version: 4,
      page_origin: 'https://app.example.com',
      origin: 'https://api.example.com',
      purpose: 'METRIC',
      request: {
        method: 'POST',
        replay: 'EXACT_CAPTURE',
        secret_headers: [],
        max_recv_data: 4096,
      },
    })
    expect(JSON.parse(JSON.stringify(validateConnector(config)))).toEqual(
      config,
    )
    await expect(configDigest(config)).resolves.toMatch(/^[a-f0-9]{64}$/)
  })

  test('parses signed account-binding metadata only for binding connectors', () => {
    const binding = cloneV4()
    binding.purpose = 'ACCOUNT_BINDING'
    binding.account_binding = {
      providerKey: 'example',
      accountVariable: 'accountId',
      walletOutput: 'wallet',
      addressType: 'EVM',
    }
    binding.variables = [
      {
        name: 'accountId',
        scalarType: 'STRING',
        source: {
          kind: 'CAPTURED_REQUEST',
          location: 'BODY_JSON',
          selector: '$.input.account',
        },
      },
    ]
    binding.resolved_variables = {}
    binding.request.matcher.query.required = {}
    binding.request.body = { input: { account: { $var: 'accountId' } } }
    binding.pipelines = [
      { output: 'wallet', sourcePath: '$.wallet', cast: 'STRING' },
    ]
    binding.disclosure = {
      key_paths: ['$.wallet'],
      scalar_paths: ['$.wallet'],
      collection_paths: [],
      max_elements: 200,
    }

    expect(validateConnector(binding)).toMatchObject({
      purpose: 'ACCOUNT_BINDING',
      account_binding: { providerKey: 'example' },
    })
    expect(() =>
      validateConnector({ ...v4Connector(), account_binding: {} }),
    ).toThrow()
    delete binding.account_binding
    expect(() => validateConnector(binding)).toThrow()
  })

  test.each([
    ['public IPv4 and explicit port', 'https://8.8.8.8:8443'],
    ['public IPv6 and explicit port', 'https://[2606:4700:4700::1111]:8443'],
  ])('accepts backend-valid V4 %s', (_name, origin) => {
    const value = cloneV4()
    value.page_origin = 'https://localhost:8443'
    value.origin = origin
    expect(validateConnector(value)).toMatchObject({ origin })
  })

  test.each([
    'https://10.0.0.1:8443',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://169.254.1.1',
    'https://172.16.0.1',
    'https://192.168.0.1',
    'https://192.0.2.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://[2001:db8::1]',
    'https://[2002::1]',
    'https://api.internal',
  ])('rejects backend-invalid V4 target origin %s', (origin) => {
    const value = cloneV4()
    value.origin = origin
    expect(() => validateConnector(value)).toThrow()
  })

  test('parses V4 GET without POST-only fields', () => {
    const value = cloneV4()
    value.request.method = 'GET'
    delete value.request.body
    delete value.request.content_type
    value.request.matcher.query.required = {
      account: { $var: 'accountId' },
      day: { $var: 'periodKey' },
    }

    expect(validateConnector(value)).toMatchObject({
      request: { method: 'GET', secret_headers: [] },
    })
  })

  test.each([
    1, 65_536,
  ])('accepts signed dynamic receive limit %i', (max_recv_data) => {
    const value = cloneV4()
    value.request.max_recv_data = max_recv_data
    expect(validateConnector(value)).toMatchObject({
      request: { max_recv_data },
    })
  })

  test.each([
    [
      'unknown connector field',
      () => Object.assign(cloneV4(), { credentialMode: 'NONE' }),
    ],
    ['wrong revision', () => Object.assign(cloneV4(), { revision: 2 })],
    [
      'enabled-state widening',
      () => Object.assign(cloneV4(), { disabled: true }),
    ],
    [
      'non-HTTPS page origin',
      () => Object.assign(cloneV4(), { page_origin: 'http://app.example.com' }),
    ],
    [
      'non-public target origin',
      () => Object.assign(cloneV4(), { origin: 'https://localhost' }),
    ],
    [
      'page field confused with target origin',
      () =>
        Object.assign(cloneV4(), {
          page_origin: 'https://api.example.com/path',
        }),
    ],
    [
      'missing replay semantics',
      () => {
        const value = cloneV4()
        delete value.request.semantics
        return value
      },
    ],
    [
      'literal secret header',
      () => {
        const value = cloneV4()
        value.request.secret_headers = ['authorization']
        return value
      },
    ],
    [
      'non-fixed sent limit',
      () => {
        const value = cloneV4()
        value.request.max_sent_data = 8191
        return value
      },
    ],
    [
      'unresolved metric variable',
      () => {
        const value = cloneV4()
        delete value.resolved_variables.accountId
        return value
      },
    ],
    [
      'two collection steps',
      () => {
        const value = cloneV4()
        value.pipelines[0].sourcePath = '$.groups[*].items[*]'
        return value
      },
    ],
    [
      'tampered disclosure plan',
      () => {
        const value = cloneV4()
        value.disclosure.scalar_paths = []
        return value
      },
    ],
    [
      'tampered disclosure element cap',
      () => {
        const value = cloneV4()
        value.disclosure.max_elements = 199
        return value
      },
    ],
    [
      'unknown nested template field',
      () => {
        const value = cloneV4()
        const body = testRecord(value.request.body)
        const input = testRecord(body.input)
        const options = testRecord(input.options)
        testRecord(options.$object).extra = true
        return value
      },
    ],
    [
      'unknown pipeline field',
      () => {
        const value = cloneV4()
        value.pipelines[0].script = 'return true'
        return value
      },
    ],
  ])('rejects V4 %s', (_name, candidate) => {
    expect(() => validateConnector(candidate())).toThrow()
  })

  test.each([
    ['zero receive bytes', 0],
    ['receive bytes above cap', 65_537],
    ['fractional receive bytes', 1.5],
  ])('rejects %s', (_name, max_recv_data) => {
    const value = cloneV4()
    value.request.max_recv_data = max_recv_data
    expect(() => validateConnector(value)).toThrow()
  })

  test('enforces V4 collection, template, variable, pipeline, and predicate limits', () => {
    const tooManyVariables = cloneV4()
    tooManyVariables.variables = Array.from({ length: 33 }, (_, index) => ({
      name: `variable${index}`,
      scalarType: 'STRING',
      source: { kind: 'BOUND_ACCOUNT', bindingKey: `binding${index}` },
    }))
    tooManyVariables.resolved_variables = Object.fromEntries(
      tooManyVariables.variables.map((item) => [
        String(item.name),
        { type: 'STRING', value: 'account' },
      ]),
    )

    const tooManyPipelines = cloneV4()
    tooManyPipelines.pipelines = Array.from({ length: 21 }, (_, index) => ({
      output: `output${index}`,
      sourcePath: '$.data.balance',
      cast: 'DECIMAL',
      valueUnit: 'USDT',
      outputUnit: 'USDT',
    }))

    const tooManyTemplateItems = cloneV4()
    tooManyTemplateItems.request.body = Array.from({ length: 201 }, () => 1)

    const deepPredicate = cloneV4()
    let predicate: Record<string, unknown> = {
      op: 'EXISTS',
      path: '$.value',
    }
    for (let index = 0; index < 4; index += 1)
      predicate = { op: 'ALL', predicates: [predicate] }
    deepPredicate.pipelines[0] = {
      output: 'balance',
      sourcePath: '$.data.items[*]',
      filter: predicate,
      valuePath: '$.value',
      cast: 'DECIMAL',
      reduce: 'SUM',
      valueUnit: 'USDT',
      outputUnit: 'USDT',
    }

    const badConstraint = cloneV4()
    testRecord(badConstraint.variables[0]?.constraints).maxLength = 1025

    const oversizedBody = cloneV4()
    oversizedBody.request.body = {
      account: { $var: 'accountId' },
      parts: Array.from({ length: 9 }, () => 'x'.repeat(1000)),
    }

    const tooManyPredicateLeaves = cloneV4()
    tooManyPredicateLeaves.pipelines[0] = {
      output: 'balance',
      sourcePath: '$.data.items[*]',
      filter: {
        op: 'ALL',
        predicates: Array.from({ length: 33 }, () => ({
          op: 'EXISTS',
          path: '$.value',
        })),
      },
      valuePath: '$.value',
      cast: 'DECIMAL',
      reduce: 'SUM',
      valueUnit: 'USDT',
      outputUnit: 'USDT',
    }

    const tooManyInValues = cloneV4()
    tooManyInValues.pipelines[0] = {
      output: 'balance',
      sourcePath: '$.data.items[*]',
      filter: {
        op: 'IN',
        path: '$.value',
        value: Array.from({ length: 33 }, (_, index) => index),
      },
      valuePath: '$.value',
      cast: 'DECIMAL',
      reduce: 'SUM',
      valueUnit: 'USDT',
      outputUnit: 'USDT',
    }

    const emptyFormArray = cloneV4()
    emptyFormArray.request.content_type = 'application/x-www-form-urlencoded'
    emptyFormArray.request.body = {
      account: { $var: 'accountId' },
      empty: [],
    }

    for (const candidate of [
      tooManyVariables,
      tooManyPipelines,
      tooManyTemplateItems,
      deepPredicate,
      badConstraint,
      oversizedBody,
      tooManyPredicateLeaves,
      tooManyInValues,
      emptyFormArray,
    ]) {
      expect(() => validateConnector(candidate)).toThrow()
    }
  })

  test('accepts only the fixed connector language', async () => {
    expect(validateConnector(connector)).toMatchObject({
      connector_id: 'github-login',
    })
    await expect(configDigest(connector)).resolves.toMatch(/^[a-f0-9]{64}$/)
    expect(
      interpret(connector, {
        response: '{"login":"octocat"}',
        status: 200,
        identity: 'octocat',
        now: '2026-08-15T00:00:00.000Z',
      }),
    ).toMatchObject({ claim: 'octocat', request_target: '/me/octocat' })
    expect(() =>
      validateConnector({ ...connector, origin: 'https://localhost' }),
    ).toThrow()
    expect(() =>
      validateConnector({
        ...connector,
        request: { ...connector.request, headers: { authorization: 'x' } },
      }),
    ).toThrow()
  })

  test('fails closed for disabled and expired connector or ticket', () => {
    expect(() =>
      assertConnectorAvailable(
        { ...connector, disabled: true },
        '2026-08-15T00:00:00.000Z',
      ),
    ).toThrow('connector is unavailable')
    expect(() =>
      assertConnectorAvailable(connector, '2031-01-01T00:00:00.000Z'),
    ).toThrow('connector is unavailable')
    expect(() =>
      assertTicketAvailable(ticket, '2031-01-01T00:00:00.000Z'),
    ).toThrow('ticket is unavailable')
  })

  test('retains only the original envelopes after schema and binding checks', async () => {
    const payload = await signedEnvelopes()
    const { publicKeys, ...response } = payload
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => response } as Response)
    try {
      const result = await fetchAndVerifySignedConfig(
        'http://localhost/config',
        {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        },
      )
      expect(result.configEnvelope).toBe(payload.config_envelope)
      expect(result.ticketEnvelope).toBe(payload.ticket_envelope)
    } finally {
      fetch.mockRestore()
    }
  })

  test('rejects a signed ticket that does not bind the verified config', async () => {
    const payload = await signedEnvelopes('b'.repeat(64))
    const { publicKeys, ...response } = payload
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({ ok: true, json: async () => response } as Response)
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        }),
      ).rejects.toThrow('ticket did not bind the verified config.')
    } finally {
      fetch.mockRestore()
    }
  })

  test('rejects malformed config and ticket envelope schemas before returning', async () => {
    const cases: {
      name: string
      mutate: (payload: Awaited<ReturnType<typeof signedEnvelopes>>) => void
    }[] = [
      {
        name: 'config envelope missing signature',
        mutate: (payload) => {
          delete (payload.config_envelope as Record<string, unknown>).signature
        },
      },
      {
        name: 'config envelope extra field',
        mutate: (payload) => {
          const envelope = payload.config_envelope as Record<string, unknown>
          envelope.extra = true
        },
      },
      {
        name: 'config envelope wrong key type',
        mutate: (payload) => {
          const envelope = payload.config_envelope as Record<string, unknown>
          envelope.key_id = 1
        },
      },
      {
        name: 'ticket envelope missing signature',
        mutate: (payload) => {
          delete (payload.ticket_envelope as Record<string, unknown>).signature
        },
      },
      {
        name: 'ticket envelope extra field',
        mutate: (payload) => {
          const envelope = payload.ticket_envelope as Record<string, unknown>
          envelope.extra = true
        },
      },
      {
        name: 'ticket envelope wrong key type',
        mutate: (payload) => {
          const envelope = payload.ticket_envelope as Record<string, unknown>
          envelope.key_id = 1
        },
      },
    ]
    for (const value of cases) {
      const payload = await signedEnvelopes()
      value.mutate(payload)
      const { publicKeys, ...response } = payload
      const fetch = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue({ ok: true, json: async () => response } as Response)
      try {
        await expect(
          fetchAndVerifySignedConfig('http://localhost/config', {
            publicKeys,
            now: '2026-08-15T00:00:00.000Z',
            local: true,
          }),
          value.name,
        ).rejects.toThrow()
      } finally {
        fetch.mockRestore()
      }
    }
  })

  test('content parser rejects page-supplied config and extra fields', () => {
    const event = {
      source: globalThis.window,
      origin: 'https://app.lhdao.top',
      data: {
        channel: ZKTLS_PAGE_CHANNEL,
        type: 'prove',
        correlationId: 'c1',
        sessionId: 's1',
        connectorId: 'github-login',
      },
    } as unknown as MessageEvent
    expect(
      parseZkTlsPageRequest(
        event,
        globalThis.window,
        'https://app.lhdao.top',
        '/verify/s1',
      ),
    ).toMatchObject({ sessionId: 's1' })
    event.data.config = connector
    expect(
      parseZkTlsPageRequest(
        event,
        globalThis.window,
        'https://app.lhdao.top',
        '/verify/s1',
      ),
    ).toBeNull()
    const wrongPathEvent = {
      ...event,
      data: {
        channel: ZKTLS_PAGE_CHANNEL,
        type: 'prove',
        correlationId: 'c1',
        sessionId: 's1',
        connectorId: 'github-login',
      },
    } as unknown as MessageEvent
    expect(
      parseZkTlsPageRequest(
        wrongPathEvent,
        globalThis.window,
        'https://app.lhdao.top',
        '/verify/s2',
      ),
    ).toBeNull()
  })

  test('background parser independently requires exact sender origin and path', () => {
    const sender = {
      id: 'extension',
      frameId: 0,
      url: 'https://app.lhdao.top/verify/s1',
    } as chrome.runtime.MessageSender
    const request = {
      type: 'zktls-prove',
      correlationId: 'c1',
      sessionId: 's1',
      connectorId: 'github-login',
    }
    const runtime = globalThis.chrome.runtime
    Object.defineProperty(runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    expect(
      parseZkTlsRuntimeRequest(request, sender, 'https://app.lhdao.top'),
    ).toMatchObject({ connectorId: 'github-login' })
    expect(
      parseZkTlsRuntimeRequest(
        request,
        { ...sender, url: 'https://app.lhdao.top/verify/s2' },
        'https://app.lhdao.top',
      ),
    ).toBeNull()
    expect(
      parseZkTlsRuntimeRequest(
        { ...request, cookie: 'no' },
        sender,
        'https://app.lhdao.top',
      ),
    ).toBeNull()
  })

  test('uses the PR #11 verifier registration and complete replay ranges', () => {
    const message = {
      id: 'job1',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: 'github-login',
      config: htmlConnector,
      ticket,
      configEnvelope,
      ticketEnvelope,
      identity: 'octocat',
      cookie: 'session=secret',
    }
    expect(sessionRegistrationPayload(message)).toEqual({
      type: 'register',
      maxRecvData: 65536,
      maxSentData: 8192,
      config_envelope: configEnvelope,
      ticket_envelope: ticketEnvelope,
      sessionData: {
        session_id: 's1',
        connector_id: 'github-login',
        revision: '1',
        interpreter_version: '1',
        config_digest: 'a'.repeat(64),
        nonce: 'n1',
      },
    })
    const registration = sessionRegistrationPayload(message) as {
      config_envelope: unknown
      ticket_envelope: unknown
    }
    expect(registration.config_envelope).toBe(configEnvelope)
    expect(registration.ticket_envelope).toBe(ticketEnvelope)
    expect(JSON.stringify(sessionRegistrationPayload(message))).not.toContain(
      'session=secret',
    )
    const urls = verifierUrls('ws://localhost:7047/session', 'registered1')
    const verifier = new URL(urls.verifierUrl)
    const proxy = new URL(urls.proxyUrl)
    expect(verifier.searchParams.get('sessionId')).toBe('registered1')
    expect(proxy.searchParams.get('sessionId')).toBe('registered1')
    expect(proxy.searchParams.has('token')).toBe(false)
    expect(proxy.href).not.toContain('github.com')
    expect(() => verifierUrls('ws://localhost:7047/session', 'bad/id')).toThrow(
      'verifier rejected session',
    )
    const sent = new TextEncoder().encode(
      'GET /profile/octocat HTTP/1.1\r\nHost: github.com\r\n\r\n',
    )
    const received = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<span data-user="octocat"></span>',
    )
    const config = revealConfig(message, sent, received)
    expect(config.sent).toMatchObject([
      { start: 0, end: 'GET /profile/octocat HTTP/1.1\r\n'.length },
    ])
    expect(config.recv[0]).toMatchObject({
      start: 0,
      end: 'HTTP/1.1 200 OK\r\n'.length,
    })
    expect(config.recv).toHaveLength(4)
    expect(() =>
      revealConfig({ ...message, config: connector }, sent, received),
    ).toThrow('JSON connectors are unsupported')
  })

  test('never registers captured request data or secret values', () => {
    const message = {
      id: 'job2',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: 'github-login',
      config: htmlConnector,
      ticket,
      configEnvelope,
      ticketEnvelope,
      identity: 'octocat',
      cookie: 'cookie=private',
      captured: {
        path: '/private',
        body: '{"token":"private"}',
        secrets: { authorization: 'Bearer private' },
      },
    }
    const payload = JSON.stringify(sessionRegistrationPayload(message))
    expect(payload).not.toContain('cookie=private')
    expect(payload).not.toContain('Bearer private')
    expect(payload).not.toContain('{"token":"private"}')
    expect(payload).not.toContain('"captured"')
  })

  test('reveals a unique JSON regex scalar but keeps JSONPath disabled', () => {
    const config = validateConnector({
      interpreter_version: 3,
      connector_id: 'product-volume',
      revision: 1,
      disabled: false,
      expires_at: '2030-01-01T00:00:00.000Z',
      origin: 'https://github.com',
      request: {
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/viewer' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['fetch'],
        },
        headers: { accept: 'application/json' },
        secret_headers: ['cookie'],
        max_sent_data: 8192,
        max_recv_data: 65536,
        replay_safety_evidence: 'The viewer endpoint is read-only.',
      },
      response_format: 'json',
      response_status: 200,
      extraction: {
        kind: 'regex',
        pattern: '^\\{"volume":(\\d+)\\}$',
        max_bytes: 32,
      },
      verifier_profile_id: 'lighthouse-v1',
    })
    if (config.interpreter_version !== 3)
      throw new Error('wrong connector version')
    const message = {
      id: 'product-job',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: config.connector_id,
      config,
      ticket: { ...ticket, interpreter_version: 3 as const },
      configEnvelope: { ...configEnvelope, config },
      ticketEnvelope,
      captured: {
        path: '/viewer',
        resource_type: 'fetch' as const,
        secrets: { cookie: 'private' },
      },
    }
    const sent = new TextEncoder().encode(
      'GET /viewer HTTP/1.1\r\nHost: github.com\r\n\r\n',
    )
    const received = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nX-Private: "volume":9999\r\nContent-Type: application/json\r\n\r\n{"volume":7200}',
    )
    const reveal = revealConfig(message, sent, received)
    const bodyStart = new TextDecoder().decode(received).indexOf('{')
    expect(
      reveal.recv.slice(1).every((range) => range.start >= bodyStart),
    ).toBe(true)
    expect(
      new TextDecoder().decode(
        received.slice(reveal.recv[3].start, reveal.recv[3].end),
      ),
    ).toBe('7200')

    const encodedResponse = (headers: string, body: Uint8Array) => {
      const head = new TextEncoder().encode(
        `HTTP/1.1 200 OK\r\n${headers ? `${headers}\r\n` : ''}\r\n`,
      )
      const result = new Uint8Array(head.length + body.length)
      result.set(head)
      result.set(body, head.length)
      return result
    }
    const body = new TextEncoder().encode('{"volume":7200}')
    expect(() =>
      revealConfig(
        message,
        sent,
        encodedResponse(
          `Content-Length: ${body.length}\r\nContent-Encoding: identity`,
          body,
        ),
      ),
    ).not.toThrow()
    expect(() =>
      revealConfig(
        message,
        sent,
        encodedResponse(`Content-Length: ${body.length + 1}`, body),
      ),
    ).toThrow('content length')
    expect(() =>
      revealConfig(
        message,
        sent,
        encodedResponse('Transfer-Encoding: chunked', body),
      ),
    ).toThrow('transfer encoding')
    expect(() =>
      revealConfig(
        message,
        sent,
        encodedResponse('Content-Encoding: gzip', body),
      ),
    ).toThrow('content encoding')
    expect(() =>
      revealConfig(
        message,
        sent,
        encodedResponse('', new Uint8Array([0xef, 0xbb, 0xbf, ...body])),
      ),
    ).toThrow('BOM')
    expect(() =>
      revealConfig(
        message,
        sent,
        encodedResponse('', new Uint8Array([0xff, ...body])),
      ),
    ).toThrow('UTF-8')

    const jsonPath = {
      ...config,
      extraction: {
        kind: 'json_path' as const,
        path: '$.volume',
        value_type: 'number' as const,
        max_bytes: 32,
      },
    }
    expect(() =>
      revealConfig({ ...message, config: jsonPath }, sent, received),
    ).toThrow('JSON connectors are unsupported')
  })
})
