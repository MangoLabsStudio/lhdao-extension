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

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
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

function decimalVariableConnector(value: string): MutableV4 {
  const config = cloneV4()
  config.variables[0] = {
    name: 'accountId',
    scalarType: 'DECIMAL',
    source: { kind: 'BOUND_ACCOUNT', bindingKey: 'example' },
  }
  config.resolved_variables.accountId = { type: 'DECIMAL', value }
  return config
}

function decimalPostFilterConnector(value: string | number): MutableV4 {
  const config = cloneV4()
  config.pipelines = [
    {
      output: 'balance',
      sourcePath: '$.items[*]',
      groupBy: { path: '$.day', interval: 'UTC_DAY' },
      valuePath: '$.amount',
      cast: 'DECIMAL',
      reduce: 'SUM',
      postFilter: { op: 'GTE', value, unit: 'USDT' },
      finalReduce: 'COUNT',
      valueUnit: 'USDT',
      outputUnit: 'days',
    },
  ]
  config.disclosure = {
    key_paths: ['$.items', '$.items[*].amount', '$.items[*].day'],
    scalar_paths: ['$.items[*].amount', '$.items[*].day'],
    collection_paths: ['$.items'],
    max_elements: 200,
  }
  return config
}

function pathConnector(
  path: string,
  keyPaths: string[],
  scalarPath = path,
): MutableV4 {
  const config = cloneV4()
  config.pipelines[0] = {
    output: 'balance',
    sourcePath: path,
    cast: 'DECIMAL',
    valueUnit: 'USDT',
    outputUnit: 'USDT',
  }
  config.disclosure = {
    key_paths: keyPaths,
    scalar_paths: [scalarPath],
    collection_paths: [],
    max_elements: 200,
  }
  return config
}

function sizedV4Connector(pathPadding: number): MutableV4 {
  const config = cloneV4()
  const keyPaths = new Set<string>()
  const collectionPaths: string[] = []
  config.pipelines = Array.from({ length: 20 }, (_, pipelineIndex) => {
    const suffix = String(pipelineIndex).padStart(2, '0')
    const source = `$.items${suffix}[*]`
    const sourceKey = `$.items${suffix}`
    keyPaths.add(sourceKey)
    collectionPaths.push(sourceKey)
    const predicates = Array.from({ length: 32 }, (_, predicateIndex) => {
      const field = `field_${suffix}_${String(predicateIndex).padStart(2, '0')}_${'x'.repeat(pathPadding)}`
      keyPaths.add(`${source}.${field}`)
      return { op: 'EXISTS', path: `$.${field}` }
    })
    return {
      output: `output${suffix}`,
      sourcePath: source,
      filter: { op: 'ALL', predicates },
      cast: 'STRING',
      reduce: 'COUNT',
      valueUnit: 'count',
      outputUnit: 'count',
    }
  })
  config.disclosure = {
    key_paths: [...keyPaths].sort(),
    scalar_paths: [],
    collection_paths: collectionPaths.sort(),
    max_elements: 200,
  }
  config.request.body = {
    operation: 'volume',
    input: { account: { $var: 'accountId' } },
    padding: Array.from({ length: 8 }, () => ''),
  }
  return config
}

function exact64KiBV4Connector(): MutableV4 {
  const encoder = new TextEncoder()
  for (let pathPadding = 0; pathPadding <= 117; pathPadding += 1) {
    const config = sizedV4Connector(pathPadding)
    const remaining = 65_536 - encoder.encode(canonicalJson(config)).byteLength
    if (remaining < 0 || remaining > 8 * 1024) continue
    const body = testRecord(config.request.body)
    const padding = body.padding as string[]
    let unfilled = remaining
    for (let index = 0; index < padding.length; index += 1) {
      const length = Math.min(1024, unfilled)
      padding[index] = 'p'.repeat(length)
      unfilled -= length
    }
    if (
      unfilled === 0 &&
      encoder.encode(canonicalJson(config)).byteLength === 65_536
    )
      return config
  }
  throw new Error('could not construct an exact 64 KiB V4 fixture')
}

async function signedV4Envelopes(
  config: Record<string, unknown> = v4Connector(),
) {
  const config_digest = await configDigest(config)
  const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])
  const config_envelope = {
    key_id: 'k1',
    config,
    config_digest,
    signature: base64Url(
      await crypto.subtle.sign(
        'Ed25519',
        key.privateKey,
        new TextEncoder().encode(`lighthouse-zktls/config/v1:${config_digest}`),
      ),
    ),
  }
  const signedTicket = {
    ...ticket,
    connector_id: 'product-volume',
    interpreter_version: 4 as const,
    config_digest,
  }
  const signTicket = async (value: unknown) =>
    base64Url(
      await crypto.subtle.sign(
        'Ed25519',
        key.privateKey,
        new TextEncoder().encode(
          `lighthouse-zktls/session-ticket/v1:${canonicalJson(value)}`,
        ),
      ),
    )
  const ticket_envelope = {
    key_id: 'k1',
    ticket: signedTicket,
    signature: await signTicket(signedTicket),
  }
  return {
    config_envelope,
    ticket_envelope,
    publicKeys: { k1: await crypto.subtle.exportKey('jwk', key.publicKey) },
    signTicket,
  }
}

describe('zkTLS strict boundaries', () => {
  test('verifies a real signed V4 config and ticket envelope round-trip', async () => {
    const payload = await signedV4Envelopes()
    const { publicKeys, signTicket: _signTicket, ...response } = payload
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(response))
    try {
      const result = await fetchAndVerifySignedConfig(
        'http://localhost/config',
        {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        },
      )
      expect(result).toMatchObject({
        config: { interpreter_version: 4 },
        ticket: { interpreter_version: 4 },
      })
      expect(Object.isFrozen(result.config)).toBe(true)
      expect(Object.isFrozen(result.config.request)).toBe(true)
      expect(Object.isFrozen(result.configEnvelope)).toBe(true)
      expect(Object.isFrozen(result.ticketEnvelope)).toBe(true)
      expect(result.configEnvelope.config).toBe(result.config)
      expect(() => {
        ;(result.config as MutableV4).origin = 'https://evil.example.com'
      }).toThrow()
    } finally {
      fetch.mockRestore()
    }
  })

  test('rejects numeric negative zero in a DECIMAL postFilter', () => {
    expect(() => validateConnector(decimalPostFilterConnector(-0))).toThrow()
  })

  test('rejects an oversized signed response before JSON parsing', async () => {
    const payload = await signedV4Envelopes()
    const { publicKeys, signTicket: _signTicket, ...response } = payload
    const oversized = `${' '.repeat(80 * 1024)}${JSON.stringify(response)}`
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(oversized, { status: 200 }))
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        }),
      ).rejects.toThrow('signed config response is too large')
    } finally {
      fetch.mockRestore()
    }
  })

  test('admits an exact 64 KiB signed V4 config within the response cap', async () => {
    const payload = await signedV4Envelopes(exact64KiBV4Connector())
    const { publicKeys, signTicket: _signTicket, ...response } = payload
    const encoded = new TextEncoder().encode(JSON.stringify(response))
    expect(encoded.byteLength).toBeGreaterThan(65_536)
    expect(encoded.byteLength).toBeLessThanOrEqual(72 * 1024)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(response))
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        }),
      ).resolves.toMatchObject({ config: { interpreter_version: 4 } })
    } finally {
      fetch.mockRestore()
    }
  })

  test('uses bounded raw JSON instead of a response.json Proxy path', async () => {
    const payload = await signedV4Envelopes()
    const { publicKeys, signTicket: _signTicket, ...response } = payload
    let proxyReads = 0
    const proxied = new Proxy(response, {
      get(target, property, receiver) {
        proxyReads += 1
        return Reflect.get(target, property, receiver)
      },
    })
    const networkResponse = jsonResponse(response)
    const json = vi
      .spyOn(networkResponse, 'json')
      .mockResolvedValue(proxied as unknown)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(networkResponse)
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        }),
      ).resolves.toMatchObject({ config: { interpreter_version: 4 } })
      expect(json).not.toHaveBeenCalled()
      expect(proxyReads).toBe(0)
    } finally {
      fetch.mockRestore()
      json.mockRestore()
    }
  })

  test('rejects signed V4 config and ticket tampering', async () => {
    const configPayload = await signedV4Envelopes()
    const configResponse = {
      config_envelope: structuredClone(configPayload.config_envelope),
      ticket_envelope: structuredClone(configPayload.ticket_envelope),
    }
    testRecord(configResponse.config_envelope.config).origin =
      'https://other.example.com'
    const configFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(configResponse))
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys: configPayload.publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        }),
      ).rejects.toThrow('config_digest did not match config')
    } finally {
      configFetch.mockRestore()
    }

    const ticketPayload = await signedV4Envelopes()
    const tamperedTicket = {
      ...ticketPayload.ticket_envelope.ticket,
      interpreter_version: 3,
    }
    const ticketResponse = {
      config_envelope: ticketPayload.config_envelope,
      ticket_envelope: {
        ...ticketPayload.ticket_envelope,
        ticket: tamperedTicket,
        signature: await ticketPayload.signTicket(tamperedTicket),
      },
    }
    const ticketFetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(ticketResponse))
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys: ticketPayload.publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        }),
      ).rejects.toThrow('ticket did not bind the verified config')
    } finally {
      ticketFetch.mockRestore()
    }
  })

  test.each([
    '999999999999.99999999',
    '-999999999999.99999999',
  ])('accepts exact Decimal(20,8) resolved boundary %s', (value) => {
    expect(validateConnector(decimalVariableConnector(value))).toMatchObject({
      resolved_variables: { accountId: { type: 'DECIMAL', value } },
    })
  })

  test.each([
    '1000000000000.00000000',
    '-1000000000000.00000000',
  ])('rejects out-of-range Decimal(20,8) resolved value %s', (value) => {
    expect(() => validateConnector(decimalVariableConnector(value))).toThrow()
  })

  test.each([
    '999999999999.99999999',
    '-999999999999.99999999',
  ])('accepts exact Decimal(20,8) postFilter boundary %s', (value) => {
    expect(validateConnector(decimalPostFilterConnector(value))).toMatchObject({
      pipelines: [
        expect.objectContaining({
          postFilter: expect.objectContaining({ value }),
        }),
      ],
    })
  })

  test.each([
    '1000000000000.00000000',
    '-1000000000000.00000000',
  ])('rejects out-of-range Decimal(20,8) postFilter %s', (value) => {
    expect(() => validateConnector(decimalPostFilterConnector(value))).toThrow()
  })

  test('keeps V3 closed to V4 page_origin metadata', () => {
    const config = {
      interpreter_version: 3,
      connector_id: 'product-volume',
      revision: 1,
      disabled: false,
      expires_at: '2030-01-01T00:00:00.000Z',
      page_origin: 'https://app.example.com',
      origin: 'https://api.example.com',
      request: {
        method: 'GET',
        matcher: {
          path: { kind: 'exact', value: '/volume' },
          query: { required: {}, optional: {}, capture: {} },
          resource_types: ['fetch'],
        },
        headers: { accept: 'application/json' },
        secret_headers: ['cookie'],
        max_sent_data: 8192,
        max_recv_data: 65536,
        replay_safety_evidence: 'The endpoint is read-only.',
      },
      response_format: 'json',
      response_status: 200,
      extraction: {
        kind: 'regex',
        pattern: '^\\{"volume":(\\d+)\\}$',
        max_bytes: 32,
      },
      verifier_profile_id: 'lighthouse-v1',
    }

    expect(() => validateConnector(config)).toThrow(
      'connector contains an unknown field',
    )
  })

  test('accepts 256-byte and 24-segment JSONPath boundaries', () => {
    const first = 'a'.repeat(128)
    const second = 'b'.repeat(119)
    const byteBoundary = `$["${first}"]["${second}"]`
    const segmentBoundary = `$${'.a'.repeat(24)}`
    const segmentPrefixes = Array.from(
      { length: 24 },
      (_, index) => `$${'.a'.repeat(index + 1)}`,
    )

    expect(new TextEncoder().encode(byteBoundary)).toHaveLength(256)
    const firstCanonical = `$.${first}`
    const byteCanonical = `${firstCanonical}.${second}`
    expect(
      validateConnector(
        pathConnector(
          byteBoundary,
          [firstCanonical, byteCanonical],
          byteCanonical,
        ),
      ),
    ).toMatchObject({ pipelines: [{ sourcePath: byteBoundary }] })
    expect(
      validateConnector(pathConnector(segmentBoundary, segmentPrefixes)),
    ).toMatchObject({ pipelines: [{ sourcePath: segmentBoundary }] })
  })

  test('rejects JSONPath byte and segment overflow', () => {
    const byteOverflow = `$["${'a'.repeat(128)}"]["${'b'.repeat(120)}"]`
    const segmentOverflow = `$${'.a'.repeat(25)}`

    expect(new TextEncoder().encode(byteOverflow)).toHaveLength(257)
    expect(() => validateConnector(pathConnector(byteOverflow, []))).toThrow()
    expect(() =>
      validateConnector(pathConnector(segmentOverflow, [])),
    ).toThrow()
  })

  test('accepts 32 query fields and rejects 33', () => {
    const boundary = cloneV4()
    boundary.request.matcher.query.required = {
      day: { $var: 'periodKey' },
      ...Object.fromEntries(
        Array.from({ length: 31 }, (_, index) => [`field${index}`, index]),
      ),
    }
    expect(validateConnector(boundary)).toMatchObject({
      request: {
        matcher: { query: { required: expect.any(Object) } },
      },
    })

    const overflow = structuredClone(boundary)
    overflow.request.matcher.query.required.field32 = 32
    expect(() => validateConnector(overflow)).toThrow()
  })

  test('enforces the deepest signed template allowed by the outer depth budget', () => {
    const nested = (wrappers: number) => {
      let value: unknown = 'leaf'
      for (let index = 0; index < wrappers; index += 1) value = [value]
      return value
    }
    const boundary = cloneV4()
    boundary.request.body = {
      account: { $var: 'accountId' },
      nested: nested(9),
    }
    expect(validateConnector(boundary)).toMatchObject({
      request: { method: 'POST' },
    })

    const overflow = cloneV4()
    overflow.request.body = {
      account: { $var: 'accountId' },
      nested: nested(10),
    }
    expect(() => validateConnector(overflow)).toThrow()
  })

  test('accepts 1024 UTF-8 scalar bytes and rejects overflow', () => {
    const boundary = cloneV4()
    boundary.request.body = {
      account: { $var: 'accountId' },
      label: 'é'.repeat(512),
    }
    expect(new TextEncoder().encode('é'.repeat(512))).toHaveLength(1024)
    expect(validateConnector(boundary)).toMatchObject({
      request: { method: 'POST' },
    })

    const overflow = cloneV4()
    overflow.request.body = {
      account: { $var: 'accountId' },
      label: 'é'.repeat(513),
    }
    expect(() => validateConnector(overflow)).toThrow()
  })

  test('accepts exact 64 KiB normalized connector and rejects one-byte overflow', () => {
    const boundary = exact64KiBV4Connector()
    expect(new TextEncoder().encode(canonicalJson(boundary))).toHaveLength(
      65_536,
    )
    expect(validateConnector(boundary)).toMatchObject({
      interpreter_version: 4,
    })

    const overflow = structuredClone(boundary)
    overflow.verifier_profile_id = `${overflow.verifier_profile_id}x`
    expect(new TextEncoder().encode(canonicalJson(overflow))).toHaveLength(
      65_537,
    )
    expect(() => validateConnector(overflow)).toThrow()
  })

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
      .mockResolvedValue(jsonResponse(response))
    try {
      const result = await fetchAndVerifySignedConfig(
        'http://localhost/config',
        {
          publicKeys,
          now: '2026-08-15T00:00:00.000Z',
          local: true,
        },
      )
      expect(result.configEnvelope).toStrictEqual(payload.config_envelope)
      expect(result.ticketEnvelope).toStrictEqual(payload.ticket_envelope)
    } finally {
      fetch.mockRestore()
    }
  })

  test('rejects a signed ticket that does not bind the verified config', async () => {
    const payload = await signedEnvelopes('b'.repeat(64))
    const { publicKeys, ...response } = payload
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(jsonResponse(response))
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
        .mockResolvedValue(jsonResponse(response))
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
