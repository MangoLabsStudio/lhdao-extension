import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  proofHttpRequest,
  revealTranscript,
  sendProofHttpRequest,
  sessionRegistrationPayload,
  tlsnWasmModuleUrl,
  transcriptRevealRanges,
  verifierUrls,
} from '@/entrypoints/zktls-offscreen/worker'
import { CaptureSession } from '@/lib/zktls/capture'
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
import { ZKTLS_PROFILE } from '@/lib/zktls/profile'
import {
  connectorTab,
  ensurePermissions,
  proveZkTlsSession,
  registerZkTlsRuntime,
} from '@/lib/zktls/runtime'
import { parseZkTlsRuntimeRequest } from '@/lib/zktls/runtime-request'
import * as signedConfig from '@/lib/zktls/signed-config'
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
          options: { day: { $var: 'periodKey' } },
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

const GZIP_INTEGRATION_FIXTURE = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-gzip.json', 'utf8'),
) as {
  connector: Record<string, unknown>
  configDigest: string
  identityConfigDigest: string
}
const EVM_PREFIX_INTEGRATION_FIXTURE = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-evm-prefix.json', 'utf8'),
) as { cast: string }
const WINDOW_INTEGRATION_FIXTURE = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-window.json', 'utf8'),
) as { connector: Record<string, unknown>; hashes: { connector: string } }
const PUBLIC_HEADER_INTEGRATION_FIXTURE = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-public-headers.json', 'utf8'),
) as { connector: Record<string, unknown>; hashes: { connector: string } }
const FIELD_DIFFERENCE_INTEGRATION_FIXTURE = JSON.parse(
  readFileSync('test/fixtures/product-zktls-v4-field-difference.json', 'utf8'),
) as {
  connector: Record<string, unknown>
  configDigest: string
  pipeline: {
    difference: { leftPath: string; rightPath: string }
    fixedDecimals: number
  }
}

function gzipIntegrationConnector(): Record<string, unknown> {
  return structuredClone(GZIP_INTEGRATION_FIXTURE.connector)
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

function differenceConnector(collection = false): MutableV4 {
  const config = cloneV4()
  config.pipelines[0] = {
    output: 'balance',
    sourcePath: collection ? '$.items[*]' : '$.data',
    difference: { leftPath: '$.credits', rightPath: '$.debits' },
    cast: 'DECIMAL',
    ...(collection ? { reduce: 'SUM' } : {}),
    valueUnit: 'USDT',
    outputUnit: 'USDT',
  }
  config.disclosure = {
    key_paths: collection
      ? ['$.items', '$.items[*].credits', '$.items[*].debits']
      : ['$.data', '$.data.credits', '$.data.debits'],
    scalar_paths: collection
      ? ['$.items[*].credits', '$.items[*].debits']
      : ['$.data.credits', '$.data.debits'],
    collection_paths: collection ? ['$.items'] : [],
    max_elements: 200,
  }
  return config
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

  test('checks ticket availability after the signed config response arrives', async () => {
    const payload = await signedV4Envelopes()
    const { publicKeys, signTicket: _signTicket, ...response } = payload
    let responseArrived = false
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      responseArrived = true
      return jsonResponse(response)
    })
    const now = vi.fn(() => {
      expect(responseArrived).toBe(true)
      return '2026-08-15T00:00:00.000Z'
    })
    try {
      await expect(
        fetchAndVerifySignedConfig('http://localhost/config', {
          publicKeys,
          now,
          local: true,
        }),
      ).resolves.toMatchObject({ ticket: { interpreter_version: 4 } })
      expect(now).toHaveBeenCalledOnce()
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

  test('parses and freezes signed public request headers', () => {
    const config = cloneV4()
    config.request.public_headers = {
      'x-z-client': 'public-z',
      'x-a-client': 'public-a',
    }

    const normalized = validateConnector(config)
    if (normalized.interpreter_version !== 4) throw new Error('wrong connector')

    expect(normalized.request.public_headers).toEqual({
      'x-a-client': 'public-a',
      'x-z-client': 'public-z',
    })
    expect(Object.isFrozen(normalized.request.public_headers)).toBe(true)
  })

  test.each([
    { authorization: 'public' },
    { 'content-type': 'application/json' },
    { origin: 'https://app.example.com' },
    { 'X-Client-Type': 'public' },
    { 'x-client-type': '' },
    { 'x-client-type': ' public ' },
  ])('rejects invalid signed public request headers %#', (public_headers) => {
    const config = cloneV4()
    config.request.public_headers = public_headers
    expect(() => validateConnector(config)).toThrow()
  })

  test('matches the backend gzip integration connector bytes and digest', async () => {
    const normalized = validateConnector(gzipIntegrationConnector())
    const canonical = canonicalJson(normalized)

    expect(new TextEncoder().encode(canonical)).toHaveLength(1255)
    await expect(configDigest(normalized)).resolves.toBe(
      GZIP_INTEGRATION_FIXTURE.configDigest,
    )

    const identity = gzipIntegrationConnector()
    delete identity.response_content_encoding
    delete identity.max_decoded_data
    await expect(configDigest(validateConnector(identity))).resolves.toBe(
      GZIP_INTEGRATION_FIXTURE.identityConfigDigest,
    )
  })

  test('matches the shared generic window connector and digest', async () => {
    const normalized = validateConnector(
      structuredClone(WINDOW_INTEGRATION_FIXTURE.connector),
    )

    await expect(configDigest(normalized)).resolves.toBe(
      WINDOW_INTEGRATION_FIXTURE.hashes.connector,
    )
  })

  test('matches the shared signed public-header connector and digest', async () => {
    const normalized = validateConnector(
      structuredClone(PUBLIC_HEADER_INTEGRATION_FIXTURE.connector),
    )

    await expect(configDigest(normalized)).resolves.toBe(
      PUBLIC_HEADER_INTEGRATION_FIXTURE.hashes.connector,
    )
    expect(
      normalized.interpreter_version === 4
        ? normalized.request.public_headers
        : undefined,
    ).toEqual({ 'x-client-type': 'public' })
  })

  test('parses and freezes the shared signed field-difference connector', async () => {
    const normalized = validateConnector(
      structuredClone(FIELD_DIFFERENCE_INTEGRATION_FIXTURE.connector),
    )
    if (normalized.interpreter_version !== 4) throw new Error('wrong connector')

    expect(normalized.pipelines[0]?.difference).toEqual(
      FIELD_DIFFERENCE_INTEGRATION_FIXTURE.pipeline.difference,
    )
    expect(normalized.pipelines[0]?.fixedDecimals).toBe(18)
    expect(Object.isFrozen(normalized.pipelines[0]?.difference)).toBe(true)
    expect(normalized.disclosure.scalar_paths).toEqual([
      '$.events[*].post_balance.spot.balance.amount',
      '$.events[*].pre_balance.spot.balance.amount',
    ])
    await expect(configDigest(normalized)).resolves.toBe(
      FIELD_DIFFERENCE_INTEGRATION_FIXTURE.configDigest,
    )
  })

  test.each([
    1, 65_536,
  ])('parses and freezes the signed V4 gzip response contract at %i bytes', async (maxDecodedData) => {
    const config = {
      ...v4Connector(),
      response_content_encoding: 'gzip',
      max_decoded_data: maxDecodedData,
    }
    const payload = await signedV4Envelopes(config)
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

      expect(result.config).toMatchObject({
        response_content_encoding: 'gzip',
        max_decoded_data: maxDecodedData,
      })
      expect(Object.isFrozen(result.config)).toBe(true)
      expect(Object.isFrozen(result.config.request)).toBe(true)
    } finally {
      fetch.mockRestore()
    }
  })

  test('keeps identity V4 connectors free of gzip response fields', () => {
    const result = validateConnector(v4Connector())

    expect(Object.hasOwn(result, 'response_content_encoding')).toBe(false)
    expect(Object.hasOwn(result, 'max_decoded_data')).toBe(false)
  })

  test('parses, copies, and deeply freezes the signed V4 chunked framing contract', async () => {
    const config = {
      ...v4Connector(),
      response_transfer_encoding: 'chunked',
    }
    const direct = validateConnector(config)
    expect(direct).not.toBe(config)
    config.response_transfer_encoding = 'identity'
    expect(direct).toMatchObject({ response_transfer_encoding: 'chunked' })
    config.response_transfer_encoding = 'chunked'
    const payload = await signedV4Envelopes(config)
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

      expect(result.config).toMatchObject({
        response_transfer_encoding: 'chunked',
      })
      expect(Object.isFrozen(result.config)).toBe(true)
      expect(() => {
        ;(result.config as Record<string, unknown>).response_transfer_encoding =
          'fixed'
      }).toThrow()
    } finally {
      fetch.mockRestore()
    }
  })

  test('keeps fixed-length V4 connectors free of a transfer-encoding field', () => {
    const result = validateConnector(v4Connector())

    expect(Object.hasOwn(result, 'response_transfer_encoding')).toBe(false)
  })

  test.each([
    'identity',
    'CHUNKED',
    'br',
  ])('rejects invalid V4 response framing %s', (response_transfer_encoding) => {
    expect(() =>
      validateConnector({ ...v4Connector(), response_transfer_encoding }),
    ).toThrow()
  })

  test('rejects accessor-backed, hidden, and proxied V4 response framing', () => {
    const accessor = v4Connector()
    let reads = 0
    Object.defineProperty(accessor, 'response_transfer_encoding', {
      enumerable: true,
      get() {
        reads += 1
        return 'chunked'
      },
    })
    expect(() => validateConnector(accessor)).toThrow()
    expect(reads).toBe(0)

    const hidden = v4Connector()
    Object.defineProperty(hidden, 'response_transfer_encoding', {
      enumerable: false,
      value: 'chunked',
    })
    expect(() => validateConnector(hidden)).toThrow()

    expect(() =>
      validateConnector(
        new Proxy(
          { ...v4Connector(), response_transfer_encoding: 'chunked' },
          {},
        ),
      ),
    ).toThrow()
  })

  test.each([
    { response_content_encoding: 'gzip' },
    { max_decoded_data: 64 },
    { response_content_encoding: 'br', max_decoded_data: 64 },
    { response_content_encoding: 'GZIP', max_decoded_data: 64 },
    { response_content_encoding: 'gzip', max_decoded_data: 0 },
    { response_content_encoding: 'gzip', max_decoded_data: 65_537 },
    { response_content_encoding: 'gzip', max_decoded_data: 1.5 },
    {
      response_content_encoding: 'gzip',
      max_decoded_data: 64,
      response_encoding_options: {},
    },
  ])('rejects invalid V4 gzip response contract %#', (fields) => {
    expect(() => validateConnector({ ...v4Connector(), ...fields })).toThrow()
  })

  test('rejects accessor-backed and revoked-proxy V4 gzip fields', () => {
    const accessor = v4Connector()
    let reads = 0
    Object.defineProperty(accessor, 'response_content_encoding', {
      enumerable: true,
      get() {
        reads += 1
        return 'gzip'
      },
    })
    Object.assign(accessor, { max_decoded_data: 64 })

    expect(() => validateConnector(accessor)).toThrow()
    expect(reads).toBe(0)

    const { proxy, revoke } = Proxy.revocable(
      {
        ...v4Connector(),
        response_content_encoding: 'gzip',
        max_decoded_data: 64,
      },
      {},
    )
    revoke()
    expect(() => validateConnector(proxy)).toThrow()
  })

  test('returns a deeply frozen V4 gzip result and rejects proxies', () => {
    const config = {
      ...v4Connector(),
      response_content_encoding: 'gzip',
      max_decoded_data: 64,
    }
    const result = validateConnector(config)

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.request)).toBe(true)
    expect(Object.isFrozen((result as MutableV4).request.matcher)).toBe(true)
    expect(() => validateConnector(new Proxy(config, {}))).toThrow()
  })

  test('accepts signed generic rolling-window transforms', () => {
    const config = cloneV4()
    config.period_days = 7
    config.variables.push({
      name: 'periodStart',
      scalarType: 'UTC_TIMESTAMP',
      source: { kind: 'SESSION', field: 'periodStart' },
    })
    config.resolved_variables.periodStart = {
      type: 'UTC_TIMESTAMP',
      value: '2026-08-14T00:00:00.000Z',
    }
    testRecord(testRecord(config.request.body).input).limit = 3
    config.pipelines = [
      {
        output: 'qualifyingDays',
        sourcePath: '$.orders[*]',
        orderBy: { path: '$.time', direction: 'DESC' },
        groupBy: { path: '$.time', interval: 'UTC_DAY' },
        valuePath: '$.amount',
        cast: 'DECIMAL',
        fixedDecimals: 18,
        absolute: true,
        timestamp: { path: '$.time', format: 'UNIX_SECONDS' },
        coverage: { kind: 'DESCENDING_WINDOW', requestLimit: 3 },
        reduce: 'SUM',
        postFilter: { op: 'GTE', value: 6000, unit: 'USDT' },
        finalReduce: 'COUNT',
        valueUnit: 'USDT',
        outputUnit: 'days',
      },
    ]
    config.disclosure = {
      key_paths: ['$.orders', '$.orders[*].amount', '$.orders[*].time'],
      scalar_paths: ['$.orders[*].amount', '$.orders[*].time'],
      collection_paths: ['$.orders'],
      max_elements: 200,
    }

    expect(validateConnector(config)).toMatchObject({
      period_days: 7,
      pipelines: [
        expect.objectContaining({
          fixedDecimals: 18,
          absolute: true,
          timestamp: { path: '$.time', format: 'UNIX_SECONDS' },
          coverage: { kind: 'DESCENDING_WINDOW', requestLimit: 3 },
        }),
      ],
    })
  })

  test.each([
    false,
    true,
  ])('accepts and binds a signed field difference (collection=%s)', (collection) => {
    const config = differenceConnector(collection)
    Object.freeze(config.pipelines[0]?.difference)
    Object.freeze(config.pipelines[0])

    const result = validateConnector(config) as MutableV4
    const difference = result.pipelines[0]?.difference

    expect(difference).toEqual({
      leftPath: '$.credits',
      rightPath: '$.debits',
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.pipelines[0])).toBe(true)
    expect(Object.isFrozen(difference)).toBe(true)
  })

  test.each([
    ['partial', { leftPath: '$.credits' }],
    [
      'extra',
      { leftPath: '$.credits', rightPath: '$.debits', mode: 'SUBTRACT' },
    ],
    ['near-match', { left_path: '$.credits', rightPath: '$.debits' }],
    ['unknown', { from: '$.credits', to: '$.debits' }],
    ['same path', { leftPath: '$.credits', rightPath: '$.credits' }],
    ['noncanonical path', { leftPath: '$["credits"]', rightPath: '$.debits' }],
    ['collection path', { leftPath: '$.credits[*]', rightPath: '$.debits' }],
  ])('rejects a %s field difference', (_name, difference) => {
    const config = differenceConnector()
    config.pipelines[0].difference = difference

    expect(() => validateConnector(config)).toThrow()
  })

  test.each([
    ['valuePath', { valuePath: '$.credits' }],
    ['nonnumeric cast', { cast: 'STRING' }],
    ['missing collection reducer', { sourcePath: '$.items[*]' }],
  ])('rejects a field difference with %s', (_name, patch) => {
    const config = differenceConnector()
    Object.assign(config.pipelines[0], patch)

    expect(() => validateConnector(config)).toThrow()
  })

  test('rejects field-difference accessors without reading them', () => {
    for (const nested of [false, true]) {
      const config = differenceConnector()
      let reads = 0
      Object.defineProperty(
        nested ? config.pipelines[0].difference : config.pipelines[0],
        nested ? 'leftPath' : 'difference',
        {
          enumerable: true,
          get() {
            reads += 1
            return nested
              ? '$.credits'
              : { leftPath: '$.credits', rightPath: '$.debits' }
          },
        },
      )

      expect(() => validateConnector(config)).toThrow()
      expect(reads).toBe(0)
    }
  })

  test.each([
    'pipeline',
    'difference',
  ] as const)('rejects transparent and revoked %s proxies without value reads', (level) => {
    for (const revoked of [false, true]) {
      const config = differenceConnector()
      const target =
        level === 'pipeline'
          ? config.pipelines[0]
          : testRecord(config.pipelines[0].difference)
      let reads = 0
      const revocable = Proxy.revocable(target, {
        get(inner, property, receiver) {
          reads += 1
          return Reflect.get(inner, property, receiver)
        },
      })
      if (revoked) revocable.revoke()
      if (level === 'pipeline') config.pipelines[0] = revocable.proxy
      else config.pipelines[0].difference = revocable.proxy

      expect(() => validateConnector(config)).toThrow()
      expect(reads).toBe(0)
    }
  })

  test.each([
    { period_days: 0 },
    { period_days: 366 },
    {
      period_days: 7,
      coverage: { kind: 'DESCENDING_WINDOW', requestLimit: 4 },
    },
    { period_days: 7, timestamp: { path: '$.time', format: 'AUTO' } },
    { period_days: 7, fixedDecimals: 19 },
  ])('rejects invalid rolling-window contract %#', (patch) => {
    const config = cloneV4()
    Object.assign(
      config,
      { period_days: 7 },
      patch.period_days === undefined ? {} : { period_days: patch.period_days },
    )
    config.variables.push({
      name: 'periodStart',
      scalarType: 'UTC_TIMESTAMP',
      source: { kind: 'SESSION', field: 'periodStart' },
    })
    config.resolved_variables.periodStart = {
      type: 'UTC_TIMESTAMP',
      value: '2026-08-14T00:00:00.000Z',
    }
    testRecord(testRecord(config.request.body).input).limit = 3
    config.pipelines[0] = {
      output: 'balance',
      sourcePath: '$.items[*]',
      orderBy: { path: '$.time', direction: 'DESC' },
      valuePath: '$.amount',
      cast: 'DECIMAL',
      fixedDecimals: patch.fixedDecimals ?? 18,
      timestamp: patch.timestamp ?? { path: '$.time', format: 'UNIX_SECONDS' },
      coverage: patch.coverage ?? {
        kind: 'DESCENDING_WINDOW',
        requestLimit: 3,
      },
      reduce: 'SUM',
      valueUnit: 'USDT',
      outputUnit: 'USDT',
    }
    config.disclosure = {
      key_paths: ['$.items', '$.items[*].amount', '$.items[*].time'],
      scalar_paths: ['$.items[*].amount', '$.items[*].time'],
      collection_paths: ['$.items'],
      max_elements: 200,
    }

    expect(() => validateConnector(config)).toThrow()
  })

  test.each([
    'root',
    'request',
  ] as const)('deep-freezes nested V4 gzip data below a shallow-frozen %s', (frozenNode) => {
    const config = Object.assign(cloneV4(), {
      response_content_encoding: 'gzip',
      max_decoded_data: 64,
    })
    Object.freeze(frozenNode === 'root' ? config : config.request)

    const result = validateConnector(config) as MutableV4

    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.request)).toBe(true)
    expect(Object.isFrozen(result.request.matcher)).toBe(true)
    expect(Object.isFrozen(result.request.matcher.query)).toBe(true)
    expect(() => {
      result.request.matcher.path = {
        kind: 'exact',
        value: '/changed',
      }
    }).toThrow()
  })

  test('rejects ALLOW_EXTRA anywhere in a signed V4 request template', () => {
    const body = cloneV4()
    body.request.body = {
      operation: 'volume',
      input: {
        $object: {
          mode: 'ALLOW_EXTRA',
          fields: { account: { $var: 'accountId' } },
        },
      },
    }
    expect(() => validateConnector(body)).toThrow()

    const query = cloneV4()
    query.request.matcher.query.required = {
      filter: {
        $object: {
          mode: 'ALLOW_EXTRA',
          fields: { day: { $var: 'periodKey' } },
        },
      },
    }
    expect(() => validateConnector(query)).toThrow()
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
    const missingAccountBinding = structuredClone(binding)

    expect(validateConnector(binding)).toMatchObject({
      purpose: 'ACCOUNT_BINDING',
      account_binding: { providerKey: 'example' },
    })
    expect(() =>
      validateConnector({ ...v4Connector(), account_binding: {} }),
    ).toThrow()
    delete missingAccountBinding.account_binding
    expect(() => validateConnector(missingAccountBinding)).toThrow()
  })

  test('parses a signed bytes32-prefix wallet cast as a scalar string output', () => {
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
      {
        output: 'wallet',
        sourcePath: '$.subaccount',
        cast: EVM_PREFIX_INTEGRATION_FIXTURE.cast as never,
      },
    ]
    binding.disclosure = {
      key_paths: ['$.subaccount'],
      scalar_paths: ['$.subaccount'],
      collection_paths: [],
      max_elements: 200,
    }

    const result = validateConnector(binding)

    expect(result).toMatchObject({
      pipelines: [
        {
          output: 'wallet',
          cast: 'EVM_ADDRESS_FROM_BYTES32_PREFIX',
        },
      ],
    })
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen((result as typeof binding).pipelines[0])).toBe(true)
  })

  test.each([
    { valueUnit: 'address', outputUnit: 'address' },
    {
      sourcePath: '$.rows[*]',
      reduce: 'COUNT',
      valueUnit: 'count',
      outputUnit: 'count',
    },
  ])('rejects invalid bytes32-prefix wallet pipeline stages: %p', (patch) => {
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
      {
        output: 'wallet',
        sourcePath: '$.subaccount',
        cast: 'EVM_ADDRESS_FROM_BYTES32_PREFIX' as never,
        ...patch,
      },
    ]

    expect(() => validateConnector(binding)).toThrow()
  })

  test('accepts V4 DNS origins with punycode on the default HTTPS port', () => {
    const value = cloneV4()
    value.page_origin = 'https://xn--bcher-kva.example'
    value.origin = 'https://api.example.com'
    expect(validateConnector(value)).toMatchObject({
      page_origin: value.page_origin,
      origin: value.origin,
    })
  })

  test.each([
    'https://app.example.com:443',
    'https://app.example.com:8443',
    'https://api.example.com:9443',
  ])('rejects the non-default V4 HTTPS port %s', (origin) => {
    for (const field of ['page_origin', 'origin'] as const) {
      const value = cloneV4()
      value[field] = origin
      expect(() => validateConnector(value)).toThrow()
    }
  })

  test.each([
    'https://8.8.8.8:8443',
    'https://10.0.0.1:8443',
    'https://100.64.0.1',
    'https://127.0.0.1',
    'https://169.254.1.1',
    'https://172.16.0.1',
    'https://192.168.0.1',
    'https://192.0.2.1',
    'https://198.51.100.1',
    'https://203.0.113.1',
    'https://[2606:4700:4700::1111]:8443',
    'https://[2001:db8::1]',
    'https://[2002::1]',
    'https://api.internal',
  ])('rejects V4 IP or internal origin %s for page and target', (origin) => {
    for (const field of ['page_origin', 'origin'] as const) {
      const value = cloneV4()
      value[field] = origin
      expect(() => validateConnector(value)).toThrow()
    }
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

  test('accepts a same-origin V4 page and public target', () => {
    const value = cloneV4()
    value.page_origin = value.origin as string
    expect(validateConnector(value)).toMatchObject({
      page_origin: value.origin,
      origin: value.origin,
    })
  })

  test('rejects form POST connectors until exact raw form capture is available', () => {
    const value = cloneV4()
    value.request.content_type = 'application/x-www-form-urlencoded'
    value.request.matcher.query.required = {
      day: { $var: 'periodKey' },
    }
    value.request.body = { account: { $var: 'accountId' } }
    expect(() => validateConnector(value)).toThrow('content_type')
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

  test('allows five seconds of issuer clock skew but keeps expiry strict', () => {
    expect(() =>
      assertTicketAvailable(ticket, '2026-08-14T23:59:55.000Z'),
    ).not.toThrow()
    expect(() =>
      assertTicketAvailable(ticket, '2026-08-14T23:59:54.999Z'),
    ).toThrow('ticket is unavailable')
    expect(() => assertTicketAvailable(ticket, ticket.expires_at)).toThrow(
      'ticket is unavailable',
    )
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

  test('uses the PR #11 verifier registration and complete replay ranges', async () => {
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
    const replay = proofHttpRequest(message)
    expect(replay.uri).toBe('/profile/octocat')
    expect([...replay.headers.keys()]).toEqual([
      'host',
      'accept-encoding',
      'connection',
      'x-requested-with',
      'cookie',
    ])
    expect(replay.body).toBeUndefined()
    const sent = new TextEncoder().encode(
      'GET /profile/octocat HTTP/1.1\r\nHost: github.com\r\n\r\n',
    )
    const received = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<span data-user="octocat"></span>',
    )
    const config = await transcriptRevealRanges(message, sent, received)
    expect(config.sent).toMatchObject([
      { start: 0, end: 'GET /profile/octocat HTTP/1.1\r\n'.length },
    ])
    expect(config.recv[0]).toMatchObject({
      start: 0,
      end: 'HTTP/1.1 200 OK\r\n'.length,
    })
    expect(config.recv).toHaveLength(4)
    await expect(
      transcriptRevealRanges({ ...message, config: connector }, sent, received),
    ).rejects.toThrow('JSON connectors are unsupported')
  })

  test('loads TLSNotary from the packaged extension module', () => {
    expect(
      tlsnWasmModuleUrl(
        'chrome-extension://extension/assets/worker-content-hash.js',
      ),
    ).toBe('chrome-extension://extension/tlsn_wasm.js')
    expect(
      tlsnWasmModuleUrl(
        'moz-extension://extension/assets/worker-content-hash.js?old=1#hash',
      ),
    ).toBe('moz-extension://extension/tlsn_wasm.js')
    expect(() =>
      tlsnWasmModuleUrl('https://evil.example/assets/worker.js'),
    ).toThrow('TLSNotary module URL is invalid')
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

  test('zeroes V1 secret header bytes after a hanging send rejects', async () => {
    const message = {
      id: 'secret-job',
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
    let rejectSend: ((error: Error) => void) | undefined
    let secretBytes: number[] | undefined
    const sending = sendProofHttpRequest(message, async (request) => {
      secretBytes = request.headers.get('cookie')
      await new Promise<void>((_resolve, reject) => {
        rejectSend = reject
      })
    })

    await vi.waitFor(() => expect(secretBytes).toBeDefined())
    expect(new TextDecoder().decode(new Uint8Array(secretBytes!))).toBe(
      'session=secret',
    )
    expect(message.cookie).toBe('')

    rejectSend?.(new Error('send failed'))
    await expect(sending).rejects.toThrow('send failed')
    expect(secretBytes).toEqual(new Array(secretBytes!.length).fill(0))
  })

  test('replays an immutable V4 capture with only complete public headers', () => {
    const raw = v4Connector()
    testRecord(raw.request).public_headers = { 'x-client-type': 'public' }
    const config = validateConnector(raw)
    if (config.interpreter_version !== 4) throw new Error('wrong connector')
    const captured = {
      path: '/v1/volume?day=2026-08-20',
      method: 'POST' as const,
      body: '{"operation":"volume","input":{"account":"acct-1","options":{"day":"2026-08-20"}}}',
      content_type: 'application/json' as const,
      secrets: {},
      resource_type: 'fetch' as const,
      capturedVariables: {},
    }
    const message = {
      id: 'v4-job',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: config.connector_id,
      config,
      ticket: { ...ticket, interpreter_version: 4 as const },
      configEnvelope: { ...configEnvelope, config },
      ticketEnvelope,
      captured,
    }

    const request = proofHttpRequest(message)
    captured.path = '/changed'
    captured.body = '{"changed":true}'

    expect(request.uri).toBe('/v1/volume?day=2026-08-20')
    expect(new TextDecoder().decode(new Uint8Array(request.body!))).toBe(
      '{"operation":"volume","input":{"account":"acct-1","options":{"day":"2026-08-20"}}}',
    )
    expect([...request.headers.keys()]).toEqual([
      'host',
      'connection',
      'x-client-type',
      'content-type',
      'content-length',
    ])
    expect(
      new TextDecoder().decode(
        new Uint8Array(request.headers.get('content-length')!),
      ),
    ).toBe(String(request.body!.length))
    expect(
      new TextDecoder().decode(
        new Uint8Array(request.headers.get('x-client-type')!),
      ),
    ).toBe('public')
  })

  test('derives the exact gzip V4 POST header from the signed config', async () => {
    const config = validateConnector({
      ...v4Connector(),
      response_content_encoding: 'gzip',
      max_decoded_data: 65_536,
    })
    if (config.interpreter_version !== 4) throw new Error('wrong connector')
    let ambientHeaderReads = 0
    const captured = {
      path: '/v1/volume?day=2026-08-20',
      method: 'POST' as const,
      body: '{"operation":"volume","input":{"account":"acct-1","options":{"day":"2026-08-20"}}}',
      content_type: 'application/json' as const,
      secrets: {},
      resource_type: 'fetch' as const,
      capturedVariables: {},
    }
    Object.defineProperty(captured, 'accept_encoding', {
      enumerable: true,
      get() {
        ambientHeaderReads += 1
        return 'br'
      },
    })
    const message = {
      id: 'v4-gzip-post-job',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: config.connector_id,
      config,
      ticket: { ...ticket, interpreter_version: 4 as const },
      configEnvelope: { ...configEnvelope, config },
      ticketEnvelope,
      captured,
    }

    await sendProofHttpRequest(message, async (request) => {
      expect([...request.headers.keys()]).toEqual([
        'host',
        'connection',
        'accept-encoding',
        'content-type',
        'content-length',
      ])
      expect(
        new TextDecoder().decode(
          new Uint8Array(request.headers.get('accept-encoding')!),
        ),
      ).toBe('gzip')
    })
    expect(ambientHeaderReads).toBe(0)
  })

  test('replays a V4 GET without content, custom, or secret headers', () => {
    const raw = v4Connector()
    const requestConfig = testRecord(raw.request)
    requestConfig.method = 'GET'
    delete requestConfig.body
    delete requestConfig.content_type
    testRecord(
      testRecord(testRecord(requestConfig.matcher).query).required,
    ).account = { $var: 'accountId' }
    const config = validateConnector(raw)
    if (config.interpreter_version !== 4) throw new Error('wrong connector')
    const request = proofHttpRequest({
      id: 'v4-get-job',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: config.connector_id,
      config,
      ticket: { ...ticket, interpreter_version: 4 as const },
      configEnvelope: { ...configEnvelope, config },
      ticketEnvelope,
      captured: {
        path: '/v1/volume?day=2026-08-20&account=acct-1',
        secrets: {},
        resource_type: 'fetch' as const,
        capturedVariables: {},
      },
    })

    expect(request.body).toBeUndefined()
    expect([...request.headers.keys()]).toEqual(['host', 'connection'])
  })

  test('derives the exact gzip V4 GET header from the signed config', async () => {
    const raw = Object.assign(v4Connector(), {
      response_content_encoding: 'gzip',
      max_decoded_data: 65_536,
    })
    const requestConfig = testRecord(raw.request)
    requestConfig.method = 'GET'
    delete requestConfig.body
    delete requestConfig.content_type
    testRecord(
      testRecord(testRecord(requestConfig.matcher).query).required,
    ).account = { $var: 'accountId' }
    const config = validateConnector(raw)
    if (config.interpreter_version !== 4) throw new Error('wrong connector')
    const message = {
      id: 'v4-gzip-get-job',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: config.connector_id,
      config,
      ticket: { ...ticket, interpreter_version: 4 as const },
      configEnvelope: { ...configEnvelope, config },
      ticketEnvelope,
      captured: {
        path: '/v1/volume?day=2026-08-20&account=acct-1',
        secrets: {},
        resource_type: 'fetch' as const,
        capturedVariables: {},
      },
    }

    await sendProofHttpRequest(message, async (request) => {
      expect([...request.headers.keys()]).toEqual([
        'host',
        'connection',
        'accept-encoding',
      ])
      expect(
        new TextDecoder().decode(
          new Uint8Array(request.headers.get('accept-encoding')!),
        ),
      ).toBe('gzip')
    })
  })

  test.each([
    ['fixed', false],
    ['chunked', true],
  ] as const)('passes only complete half-open V4 ranges to the prover for %s framing', async (_, chunked) => {
    const config = validateConnector({
      ...v4Connector(),
      ...(chunked ? { response_transfer_encoding: 'chunked' } : {}),
    })
    if (config.interpreter_version !== 4) throw new Error('wrong connector')
    const captured = {
      path: '/v1/volume?day=2026-08-20',
      method: 'POST' as const,
      body: '{"operation":"volume","input":{"account":"acct-1","options":{"day":"2026-08-20"}}}',
      content_type: 'application/json' as const,
      secrets: {},
      resource_type: 'fetch' as const,
      capturedVariables: {},
    }
    const message = {
      id: 'v4-reveal-job',
      type: 'zktls-worker-prove' as const,
      sessionId: 's1',
      connectorId: config.connector_id,
      config,
      ticket: { ...ticket, interpreter_version: 4 as const },
      configEnvelope: { ...configEnvelope, config },
      ticketEnvelope,
      captured,
    }
    const bodyBytes = new TextEncoder().encode(captured.body)
    const sent = new TextEncoder().encode(
      `POST ${captured.path} HTTP/1.1\r\n` +
        'Host: api.example.com\r\n' +
        'Connection: close\r\n' +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${bodyBytes.length}\r\n\r\n${captured.body}`,
    )
    const responseBody = '{"data":{"balance":100}}'
    const responseLength = new TextEncoder().encode(responseBody).length
    const received = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\n' +
        'Content-Type: application/json\r\n' +
        (chunked
          ? 'Transfer-Encoding: chunked\r\n'
          : `Content-Length: ${responseLength}\r\n`) +
        'Connection: close\r\n\r\n' +
        (chunked
          ? `${responseLength.toString(16)}\r\n${responseBody}\r\n0\r\n\r\n`
          : responseBody),
    )
    const rawReceived = received.slice()

    const stages: string[] = []
    const reveal = await transcriptRevealRanges(
      message,
      sent,
      received,
      (stage) => stages.push(stage),
    )

    expect(reveal).toEqual({
      sent: [{ start: 0, end: sent.length }],
      recv: [{ start: 0, end: received.length }],
    })
    expect(stages).toEqual(['response-framing-decoded', 'strict-json-checked'])
    const prover = { reveal: vi.fn().mockResolvedValue(undefined) }
    await revealTranscript(prover, reveal)
    expect(received).toEqual(rawReceived)
    expect(prover.reveal).toHaveBeenCalledWith(
      {
        sent: [{ start: 0, end: sent.length }],
        recv: [{ start: 0, end: received.length }],
        server_identity: true,
      },
      null,
    )
  })

  test('reveals a unique JSON regex scalar but keeps JSONPath disabled', async () => {
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
    const replay = proofHttpRequest(message)
    expect(replay.uri).toBe('/viewer')
    expect([...replay.headers.keys()]).toEqual([
      'host',
      'accept-encoding',
      'connection',
      'accept',
      'cookie',
    ])
    let secretBytes: number[] | undefined
    await sendProofHttpRequest(message, async (request) => {
      secretBytes = request.headers.get('cookie')
    })
    expect(message.captured.secrets.cookie).toBe('')
    expect(secretBytes).toEqual(new Array(secretBytes!.length).fill(0))
    const received = new TextEncoder().encode(
      'HTTP/1.1 200 OK\r\nX-Private: "volume":9999\r\nContent-Type: application/json\r\n\r\n{"volume":7200}',
    )
    const reveal = await transcriptRevealRanges(message, sent, received)
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
    await expect(
      transcriptRevealRanges(
        message,
        sent,
        encodedResponse(
          `Content-Length: ${body.length}\r\nContent-Encoding: identity`,
          body,
        ),
      ),
    ).resolves.toBeDefined()
    await expect(
      transcriptRevealRanges(
        message,
        sent,
        encodedResponse(`Content-Length: ${body.length + 1}`, body),
      ),
    ).rejects.toThrow('content length')
    await expect(
      transcriptRevealRanges(
        message,
        sent,
        encodedResponse('Transfer-Encoding: chunked', body),
      ),
    ).rejects.toThrow('transfer encoding')
    await expect(
      transcriptRevealRanges(
        message,
        sent,
        encodedResponse('Content-Encoding: gzip', body),
      ),
    ).rejects.toThrow('content encoding')
    await expect(
      transcriptRevealRanges(
        message,
        sent,
        encodedResponse('', new Uint8Array([0xef, 0xbb, 0xbf, ...body])),
      ),
    ).rejects.toThrow('BOM')
    await expect(
      transcriptRevealRanges(
        message,
        sent,
        encodedResponse('', new Uint8Array([0xff, ...body])),
      ),
    ).rejects.toThrow('UTF-8')

    const jsonPath = {
      ...config,
      extraction: {
        kind: 'json_path' as const,
        path: '$.volume',
        value_type: 'number' as const,
        max_bytes: 32,
      },
    }
    await expect(
      transcriptRevealRanges({ ...message, config: jsonPath }, sent, received),
    ).rejects.toThrow('JSON connectors are unsupported')
  })
})

describe('zkTLS V4 page and target permissions', () => {
  beforeEach(() => {
    const removed = chrome.permissions.onRemoved as unknown as {
      addListener(
        listener: (value: chrome.permissions.Permissions) => void,
      ): void
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
  })

  test('normalizes, deduplicates, and sorts one or two exact signed origins', async () => {
    const contains = vi
      .spyOn(chrome.permissions, 'contains')
      .mockImplementation((async () => true) as never)

    await ensurePermissions(
      [
        'https://api.example.com',
        'https://app.example.com',
        'https://api.example.com',
      ],
      'product-volume',
    )

    expect(contains).toHaveBeenCalledWith({
      origins: ['https://api.example.com/*', 'https://app.example.com/*'],
    })
    await expect(
      ensurePermissions(
        [
          'https://a.example.com',
          'https://b.example.com',
          'https://c.example.com',
        ],
        'product-volume',
      ),
    ).rejects.toThrow('one or two exact HTTPS origins')
  })

  test.each([
    ['https://api.example.com', 'https://api.example.com/*'],
    ['https://xn--bcher-kva.example', 'https://xn--bcher-kva.example/*'],
  ])('preserves a Chrome-exact DNS origin %s', async (origin, pattern) => {
    const contains = vi
      .spyOn(chrome.permissions, 'contains')
      .mockImplementation((async () => true) as never)
    await ensurePermissions([origin], 'product-volume')
    expect(contains).toHaveBeenCalledWith({ origins: [pattern] })
  })

  test.each([
    'https://api.example.com:8443',
    'https://xn--bcher-kva.example:9443',
  ])('rejects a non-default permission origin %s', async (origin) => {
    const contains = vi.spyOn(chrome.permissions, 'contains')
    await expect(ensurePermissions([origin], 'product-volume')).rejects.toThrow(
      'exact HTTPS origins',
    )
    expect(contains).not.toHaveBeenCalled()
  })

  test.each([
    'https://8.8.8.8:8443',
    'https://10.0.0.1',
    'https://[2606:4700:4700::1111]:8443',
    'https://[fd00::1]',
  ])('rejects the IP-literal permission origin %s', async (origin) => {
    const contains = vi.spyOn(chrome.permissions, 'contains')
    await expect(ensurePermissions([origin], 'product-volume')).rejects.toThrow(
      'exact HTTPS origins',
    )
    expect(contains).not.toHaveBeenCalled()
  })

  test.each([
    'https://*',
    'https://*.example.com',
    'https://%2A.example.com',
  ])('rejects the wildcard permission origin %s', async (origin) => {
    const contains = vi.spyOn(chrome.permissions, 'contains')
    await expect(ensurePermissions([origin], 'product-volume')).rejects.toThrow(
      'exact HTTPS origins',
    )
    expect(contains).not.toHaveBeenCalled()
  })

  test.each([
    'page_origin',
    'origin',
  ] as const)('rejects wildcard V4 %s values before runtime', (field) => {
    for (const origin of [
      'https://*',
      'https://*.example.com',
      'https://%2A.example.com',
    ]) {
      const config = cloneV4()
      config[field] = origin
      expect(() => validateConnector(config)).toThrow('exact HTTPS origin')
    }
  })

  test('selects only a tab at the signed page origin', async () => {
    const query = vi
      .spyOn(chrome.tabs, 'query')
      .mockResolvedValueOnce([
        { id: 3, url: 'https://api.example.com/v1/volume' } as chrome.tabs.Tab,
      ])
      .mockResolvedValueOnce([
        { id: 7, url: 'https://app.example.com/dashboard' } as chrome.tabs.Tab,
      ])

    await expect(
      connectorTab('https://app.example.com'),
    ).resolves.toMatchObject({
      id: 7,
    })
    expect(query).toHaveBeenNthCalledWith(2, {
      url: 'https://app.example.com/*',
    })
  })

  test('rejects a non-default port before an exact-origin tab query', async () => {
    const query = vi.spyOn(chrome.tabs, 'query')

    await expect(connectorTab('https://app.example.com:8443')).rejects.toThrow(
      'exact HTTPS origins',
    )
    expect(query).toHaveBeenCalledTimes(1)
    expect(query).toHaveBeenCalledWith({
      active: true,
      lastFocusedWindow: true,
    })
  })

  test('permission messages reject page-supplied origins and malformed senders', async () => {
    Object.defineProperty(chrome.runtime, 'id', {
      value: 'extension',
      configurable: true,
    })
    vi.spyOn(chrome.permissions, 'contains').mockImplementation(
      (async () => false) as never,
    )
    const create = vi
      .spyOn(chrome.tabs, 'create')
      .mockImplementation((async () => ({ id: 9 })) as never)
    let messageListener:
      | ((
          message: unknown,
          sender: chrome.runtime.MessageSender,
          sendResponse?: (response?: unknown) => void,
        ) => unknown)
      | undefined
    vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(
      (listener) => {
        messageListener = listener as typeof messageListener
      },
    )
    vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation(
      (() => undefined) as never,
    )
    for (const event of [
      chrome.webRequest.onBeforeRequest,
      chrome.webRequest.onBeforeSendHeaders,
      chrome.webRequest.onBeforeRedirect,
      chrome.webRequest.onErrorOccurred,
      chrome.webRequest.onCompleted,
    ])
      vi.spyOn(event, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
    registerZkTlsRuntime()

    const pending = ensurePermissions(
      ['https://app.example.com', 'https://api.example.com'],
      'product-volume',
    )
    const pendingRejected = expect(pending).rejects.toThrow()
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
    const permissionPage = chrome.runtime.getURL('zktls-permission.html')
    const requestId = new URL(
      (create.mock.calls[0]?.[0] as { url: string }).url,
    ).searchParams.get('request_id')
    const senderUrl = `${permissionPage}?request_id=${encodeURIComponent(requestId ?? '')}`
    const sender = { id: 'extension', url: senderUrl }

    expect(
      messageListener?.(
        { type: 'zktls-permission-preview', requestId },
        { id: 'extension', url: 'not a URL' },
      ),
    ).toBeNull()
    for (const invalidSender of [
      {
        id: 'extension',
        url: `https://${new URL(permissionPage).host}${new URL(permissionPage).pathname}?request_id=${encodeURIComponent(requestId ?? '')}`,
      },
      {
        id: 'wrong-extension',
        url: senderUrl,
      },
      {
        id: 'extension',
        url: permissionPage,
      },
      {
        id: 'extension',
        url: `${permissionPage}?request_id=wrong`,
      },
      {
        id: 'extension',
        url: `${permissionPage}?request_id=`,
      },
      {
        id: 'extension',
        url: `${senderUrl}&origin=https://evil.example.com`,
      },
      {
        id: 'extension',
        url: `${senderUrl}&request_id=${encodeURIComponent(requestId ?? '')}`,
      },
      {
        id: 'extension',
        url: `${senderUrl}&`,
      },
      {
        id: 'extension',
        url: `${senderUrl}#permission`,
      },
      {
        id: 'extension',
        url: `${senderUrl}#`,
      },
    ])
      expect(
        messageListener?.(
          { type: 'zktls-permission-preview', requestId },
          invalidSender,
        ),
      ).toBeNull()
    expect(
      messageListener?.(
        {
          type: 'zktls-permission-preview',
          requestId,
          origins: ['https://evil.example.com'],
        },
        sender,
      ),
    ).toBeNull()
    expect(
      messageListener?.(
        {
          type: 'zktls-permission-result',
          requestId,
          granted: true,
          origins: ['https://evil.example.com'],
        },
        sender,
      ),
    ).toBeNull()
    const previewResponse = vi.fn()
    expect(
      messageListener?.(
        { type: 'zktls-permission-preview', requestId },
        sender,
        previewResponse,
      ),
    ).toBe(true)
    expect(previewResponse).toHaveBeenCalledWith({
      origins: ['https://api.example.com', 'https://app.example.com'],
      connectorId: 'product-volume',
    })
    const resultResponse = vi.fn()
    expect(
      messageListener?.(
        { type: 'zktls-permission-result', requestId, granted: false },
        sender,
        resultResponse,
      ),
    ).toBe(true)
    await vi.waitFor(() => expect(resultResponse).toHaveBeenCalledWith(null))
    await pendingRejected
  })

  test('old permission callbacks cannot settle or clear a newer request', async () => {
    vi.useFakeTimers()
    try {
      Object.defineProperty(chrome.runtime, 'id', {
        value: 'extension',
        configurable: true,
      })
      let permissionCheck = 0
      const deferred = new Map<number, (allowed: boolean) => void>()
      vi.spyOn(chrome.permissions, 'contains').mockImplementation((async () => {
        permissionCheck += 1
        if ([1, 3, 6].includes(permissionCheck)) return false
        if (permissionCheck === 7) return true
        if (permissionCheck === 4)
          throw new Error('permission state unavailable')
        return await new Promise<boolean>((resolve) => {
          deferred.set(permissionCheck, resolve)
        })
      }) as never)
      const create = vi
        .spyOn(chrome.tabs, 'create')
        .mockImplementation((async () => ({ id: 9 })) as never)
      let messageListener:
        | ((
            message: unknown,
            sender: chrome.runtime.MessageSender,
            sendResponse?: (response?: unknown) => void,
          ) => unknown)
        | undefined
      vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(
        (listener) => {
          messageListener = listener as typeof messageListener
        },
      )
      vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
      for (const event of [
        chrome.webRequest.onBeforeRequest,
        chrome.webRequest.onBeforeSendHeaders,
        chrome.webRequest.onBeforeRedirect,
        chrome.webRequest.onErrorOccurred,
        chrome.webRequest.onCompleted,
      ])
        vi.spyOn(event, 'addListener').mockImplementation(
          (() => undefined) as never,
        )
      registerZkTlsRuntime()
      const flush = async () => {
        await Promise.resolve()
        await Promise.resolve()
      }
      const dispatch = (
        message: unknown,
        sender: chrome.runtime.MessageSender,
      ) =>
        new Promise<unknown>((resolve) => {
          const result = messageListener?.(message, sender, resolve)
          if (result !== true) resolve(result)
        })
      const pageSender = (call: number) => {
        const page = new URL(
          (create.mock.calls[call]?.[0] as { url: string }).url,
        )
        return {
          requestId: page.searchParams.get('request_id')!,
          sender: { id: 'extension', url: page.href },
        }
      }

      const first = ensurePermissions(
        ['https://app.example.com'],
        'product-volume',
      )
      const firstOutcome = first.then(
        () => 'resolved',
        () => 'rejected',
      )
      await flush()
      expect(create).toHaveBeenCalledTimes(1)
      const p1 = pageSender(0)
      const lateFirstResult = dispatch(
        {
          type: 'zktls-permission-result',
          requestId: p1.requestId,
          granted: true,
        },
        p1.sender,
      )
      await flush()
      expect(deferred.has(2)).toBe(true)
      await vi.advanceTimersByTimeAsync(30_000)
      await expect(firstOutcome).resolves.toBe('rejected')

      const second = ensurePermissions(
        ['https://app.example.com'],
        'product-volume',
      )
      const secondOutcome = second.then(
        () => 'resolved',
        () => 'rejected',
      )
      await flush()
      expect(create).toHaveBeenCalledTimes(2)
      const p2 = pageSender(1)
      deferred.get(2)?.(true)
      await lateFirstResult
      await expect(
        dispatch(
          { type: 'zktls-permission-preview', requestId: p2.requestId },
          p2.sender,
        ),
      ).resolves.toMatchObject({ connectorId: 'product-volume' })

      const firstDuplicate = dispatch(
        {
          type: 'zktls-permission-result',
          requestId: p2.requestId,
          granted: false,
        },
        p2.sender,
      )
      const secondDuplicate = dispatch(
        {
          type: 'zktls-permission-result',
          requestId: p2.requestId,
          granted: false,
        },
        p2.sender,
      )
      await flush()
      await firstDuplicate
      await expect(secondOutcome).resolves.toBe('rejected')

      const third = ensurePermissions(
        ['https://app.example.com'],
        'product-volume',
      )
      const thirdOutcome = third.then(
        () => 'resolved',
        () => 'rejected',
      )
      await flush()
      expect(create).toHaveBeenCalledTimes(3)
      const p3 = pageSender(2)
      deferred.get(5)?.(true)
      await secondDuplicate
      await expect(
        dispatch(
          { type: 'zktls-permission-preview', requestId: p3.requestId },
          p3.sender,
        ),
      ).resolves.toMatchObject({ connectorId: 'product-volume' })

      await dispatch(
        {
          type: 'zktls-permission-result',
          requestId: p3.requestId,
          granted: false,
        },
        p3.sender,
      )
      await expect(thirdOutcome).resolves.toBe('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  test('requests both V4 origins and opens only the page origin when login is needed', async () => {
    const rawConfig = v4Connector()
    const config = validateConnector(rawConfig)
    const signed = await signedV4Envelopes(rawConfig)
    vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
      config,
      ticket: signed.ticket_envelope.ticket,
      configEnvelope: { ...signed.config_envelope, config },
      ticketEnvelope: signed.ticket_envelope,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    const contains = vi
      .spyOn(chrome.permissions, 'contains')
      .mockImplementation((async () => true) as never)
    const query = vi.spyOn(chrome.tabs, 'query').mockResolvedValue([])
    const create = vi
      .spyOn(chrome.tabs, 'create')
      .mockImplementation((async () => ({ id: 7 })) as never)

    await expect(
      proveZkTlsSession({
        correlationId: 'v4-page',
        sessionId: 's1',
        connectorId: 'product-volume',
      }),
    ).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-page',
      status: 'pending_login',
    })
    expect(contains).toHaveBeenCalledWith({
      origins: ['https://api.example.com/*', 'https://app.example.com/*'],
    })
    expect(query).toHaveBeenCalledWith({
      url: 'https://app.example.com/*',
    })
    expect(create).toHaveBeenCalledWith({ url: 'https://app.example.com' })
    expect(create).not.toHaveBeenCalledWith({ url: 'https://api.example.com' })
  })

  test('fails closed when the selected V4 page tab navigates before capture', async () => {
    const rawConfig = v4Connector()
    const config = validateConnector(rawConfig)
    const signed = await signedV4Envelopes(rawConfig)
    vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
      config,
      ticket: signed.ticket_envelope.ticket,
      configEnvelope: { ...signed.config_envelope, config },
      ticketEnvelope: signed.ticket_envelope,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    vi.spyOn(chrome.permissions, 'contains').mockImplementation(
      (async () => true) as never,
    )
    vi.spyOn(chrome.tabs, 'query').mockResolvedValueOnce([
      { id: 7, url: 'https://app.example.com/dashboard' } as chrome.tabs.Tab,
    ])
    vi.spyOn(chrome.tabs, 'update').mockImplementation((async () => ({
      id: 7,
      url: 'https://api.example.com/v1/volume',
    })) as never)
    const create = vi.spyOn(chrome.tabs, 'create')

    await expect(
      proveZkTlsSession({
        correlationId: 'v4-navigation',
        sessionId: 's1',
        connectorId: 'product-volume',
      }),
    ).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-navigation',
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    })
    expect(create).not.toHaveBeenCalled()
  })

  test('ignores a malformed body event and submits a later exact V4 request', async () => {
    const rawConfig = v4Connector()
    const config = validateConnector(rawConfig)
    const signed = await signedV4Envelopes(rawConfig)
    vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
      config,
      ticket: signed.ticket_envelope.ticket,
      configEnvelope: { ...signed.config_envelope, config },
      ticketEnvelope: signed.ticket_envelope,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    vi.spyOn(chrome.permissions, 'contains').mockImplementation(
      (async () => true) as never,
    )
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      { id: 7, url: 'https://app.example.com/dashboard' } as chrome.tabs.Tab,
    ])
    vi.spyOn(chrome.tabs, 'update').mockImplementation((async () => ({
      id: 7,
      url: 'https://app.example.com/dashboard',
    })) as never)
    Object.defineProperty(chrome.runtime, 'getContexts', {
      configurable: true,
      value: vi
        .fn()
        .mockResolvedValue([
          { documentUrl: chrome.runtime.getURL('zktls-offscreen.html') },
        ]),
    })
    let submittedMessage: unknown
    const sendMessage = vi
      .spyOn(chrome.runtime, 'sendMessage')
      .mockImplementation((async (message: unknown) => {
        submittedMessage = structuredClone(message)
        return { status: 'submitted' }
      }) as never)
    const bodyEvent = vi
      .spyOn(chrome.webRequest.onBeforeRequest, 'addListener')
      .mockImplementation((() => undefined) as never)
    const headerEvent = vi
      .spyOn(chrome.webRequest.onBeforeSendHeaders, 'addListener')
      .mockImplementation((() => undefined) as never)
    const completedEvent = vi
      .spyOn(chrome.webRequest.onCompleted, 'addListener')
      .mockImplementation((() => undefined) as never)
    for (const event of [
      chrome.webRequest.onBeforeRedirect,
      chrome.webRequest.onErrorOccurred,
      chrome.runtime.onMessage,
    ])
      vi.spyOn(event, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
    vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation(
      (() => undefined) as never,
    )
    registerZkTlsRuntime()

    const proving = proveZkTlsSession({
      correlationId: 'v4-candidate-chain',
      sessionId: 's1',
      connectorId: 'product-volume',
    })
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalled())

    const dispatchBody = bodyEvent.mock.calls[0]?.[0] as (
      details: unknown,
    ) => void
    const dispatchHeaders = headerEvent.mock.calls[0]?.[0] as (
      details: unknown,
    ) => void
    const dispatchCompleted = completedEvent.mock.calls[0]?.[0] as (
      details: unknown,
    ) => void
    const request = {
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url: 'https://api.example.com/v1/volume?day=2026-08-20',
      type: 'fetch',
      initiator: 'https://app.example.com',
    }
    const malformed = new TextEncoder().encode('{"operation":')
    dispatchBody({
      ...request,
      requestId: 'malformed',
      requestBody: { raw: [{ bytes: malformed.buffer }] },
    })

    const exact = new TextEncoder().encode(
      '{"operation":"volume","input":{"account":"acct-1","options":{"day":"2026-08-20"}}}',
    )
    dispatchBody({
      ...request,
      requestId: 'exact',
      requestBody: { raw: [{ bytes: exact.buffer }] },
    })
    dispatchHeaders({
      ...request,
      requestId: 'exact',
      requestHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    })
    dispatchCompleted({ requestId: 'exact' })

    await expect(proving).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-candidate-chain',
      status: 'submitted',
    })
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(submittedMessage).toEqual(
      expect.objectContaining({
        type: 'zktls-offscreen-prove',
        captured: expect.objectContaining({
          body: new TextDecoder().decode(exact),
        }),
      }),
    )
  })

  test('clears an active V4 capture when its page tab leaves page_origin', async () => {
    const rawConfig = v4Connector()
    const config = validateConnector(rawConfig)
    const signed = await signedV4Envelopes(rawConfig)
    vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
      config,
      ticket: signed.ticket_envelope.ticket,
      configEnvelope: { ...signed.config_envelope, config },
      ticketEnvelope: signed.ticket_envelope,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    vi.spyOn(chrome.permissions, 'contains').mockImplementation(
      (async () => true) as never,
    )
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      { id: 7, url: 'https://app.example.com/dashboard' } as chrome.tabs.Tab,
    ])
    vi.spyOn(chrome.tabs, 'update').mockImplementation((async () => ({
      id: 7,
      url: 'https://app.example.com/dashboard',
    })) as never)
    let updated:
      | ((
          tabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) => void)
      | undefined
    vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation(
      (listener) => {
        updated = listener
      },
    )
    for (const event of [
      chrome.webRequest.onBeforeRequest,
      chrome.webRequest.onBeforeSendHeaders,
      chrome.webRequest.onBeforeRedirect,
      chrome.webRequest.onErrorOccurred,
      chrome.webRequest.onCompleted,
      chrome.runtime.onMessage,
    ])
      vi.spyOn(event, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
    registerZkTlsRuntime()

    const proving = proveZkTlsSession({
      correlationId: 'v4-tab-left',
      sessionId: 's1',
      connectorId: 'product-volume',
    })
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalled())
    updated?.(7, { url: 'https://elsewhere.example.com/' }, {
      id: 7,
      url: 'https://elsewhere.example.com/',
    } as chrome.tabs.Tab)

    await expect(proving).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-tab-left',
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    })
  })

  test('settles an active V4 job as permission denied when a required origin is removed', async () => {
    const rawConfig = v4Connector()
    const config = validateConnector(rawConfig)
    const signed = await signedV4Envelopes(rawConfig)
    vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
      config,
      ticket: signed.ticket_envelope.ticket,
      configEnvelope: { ...signed.config_envelope, config },
      ticketEnvelope: signed.ticket_envelope,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    let permissionChecks = 0
    const contains = vi
      .spyOn(chrome.permissions, 'contains')
      .mockImplementation((async () => {
        permissionChecks += 1
        return permissionChecks <= 2
      }) as never)
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      { id: 7, url: 'https://app.example.com/dashboard' } as chrome.tabs.Tab,
    ])
    vi.spyOn(chrome.tabs, 'update').mockImplementation((async () => ({
      id: 7,
      url: 'https://app.example.com/dashboard',
    })) as never)
    let removed:
      | ((permissions: chrome.permissions.Permissions) => void)
      | undefined
    const removedEvent = chrome.permissions.onRemoved as unknown as {
      addListener(
        listener: (value: chrome.permissions.Permissions) => void,
      ): void
      removeListener(
        listener: (value: chrome.permissions.Permissions) => void,
      ): void
    }
    const addRemoved = vi
      .spyOn(removedEvent, 'addListener')
      .mockImplementation((listener) => {
        removed = listener
      })
    const removeRemoved = vi
      .spyOn(removedEvent, 'removeListener')
      .mockImplementation(() => undefined)
    const clear = vi.spyOn(CaptureSession.prototype, 'clear')

    const proving = proveZkTlsSession({
      correlationId: 'v4-permission-removed',
      sessionId: 's1',
      connectorId: 'product-volume',
    })
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalled())
    expect(addRemoved).toHaveBeenCalledTimes(1)
    removed?.({ origins: ['https://unrelated.example.com/*'] })
    await vi.waitFor(() => expect(contains).toHaveBeenCalledTimes(2))
    expect(removeRemoved).not.toHaveBeenCalled()
    removed?.({ origins: ['https://*/*'] })
    removed?.({ origins: ['https://*/*'] })
    await vi.waitFor(() => expect(contains).toHaveBeenCalledTimes(4))

    await expect(proving).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-permission-removed',
      status: 'error',
      code: 'PERMISSION_DENIED',
    })
    expect(clear).toHaveBeenCalledTimes(1)
    expect(removeRemoved).toHaveBeenCalledTimes(1)
    expect(removeRemoved).toHaveBeenCalledWith(removed)
  })

  test('ignores a late removal check from an old job and settles duplicate checks once', async () => {
    const rawConfig = v4Connector()
    const config = validateConnector(rawConfig)
    const signed = await signedV4Envelopes(rawConfig)
    vi.spyOn(signedConfig, 'fetchAndVerifySignedConfig').mockResolvedValue({
      config,
      ticket: signed.ticket_envelope.ticket,
      configEnvelope: { ...signed.config_envelope, config },
      ticketEnvelope: signed.ticket_envelope,
    })
    Object.assign(ZKTLS_PROFILE, {
      enabled: true,
      apiEndpoint: 'https://service.lhdao.top/zktls/config',
      verifierProfileId: 'lighthouse-v1',
    })
    let permissionChecks = 0
    let resolveOldCheck: ((allowed: boolean) => void) | undefined
    const contains = vi
      .spyOn(chrome.permissions, 'contains')
      .mockImplementation((async () => {
        permissionChecks += 1
        if (permissionChecks === 1 || permissionChecks === 3) return true
        if (permissionChecks === 2)
          return await new Promise<boolean>((resolve) => {
            resolveOldCheck = resolve
          })
        if (permissionChecks === 4)
          throw new Error('permission state unavailable')
        return false
      }) as never)
    vi.spyOn(chrome.tabs, 'query').mockResolvedValue([
      { id: 7, url: 'https://app.example.com/dashboard' } as chrome.tabs.Tab,
    ])
    vi.spyOn(chrome.tabs, 'update').mockImplementation((async () => ({
      id: 7,
      url: 'https://app.example.com/dashboard',
    })) as never)
    let updated:
      | ((
          tabId: number,
          changeInfo: chrome.tabs.TabChangeInfo,
          tab: chrome.tabs.Tab,
        ) => void)
      | undefined
    vi.spyOn(chrome.tabs.onUpdated, 'addListener').mockImplementation(
      (listener) => {
        updated = listener
      },
    )
    for (const event of [
      chrome.webRequest.onBeforeRequest,
      chrome.webRequest.onBeforeSendHeaders,
      chrome.webRequest.onBeforeRedirect,
      chrome.webRequest.onErrorOccurred,
      chrome.webRequest.onCompleted,
      chrome.runtime.onMessage,
    ])
      vi.spyOn(event, 'addListener').mockImplementation(
        (() => undefined) as never,
      )
    const removed: ((permissions: chrome.permissions.Permissions) => void)[] =
      []
    const removedEvent = chrome.permissions.onRemoved as unknown as {
      addListener(
        listener: (value: chrome.permissions.Permissions) => void,
      ): void
      removeListener(
        listener: (value: chrome.permissions.Permissions) => void,
      ): void
    }
    vi.spyOn(removedEvent, 'addListener').mockImplementation((listener) => {
      removed.push(listener)
    })
    const removeRemoved = vi
      .spyOn(removedEvent, 'removeListener')
      .mockImplementation(() => undefined)
    registerZkTlsRuntime()

    const first = proveZkTlsSession({
      correlationId: 'v4-old-job',
      sessionId: 's1',
      connectorId: 'product-volume',
    })
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalledTimes(1))
    removed[0]?.({ origins: ['https://*/*'] })
    await vi.waitFor(() => expect(contains).toHaveBeenCalledTimes(2))
    updated?.(7, { url: 'https://elsewhere.example.com/' }, {
      id: 7,
      url: 'https://elsewhere.example.com/',
    } as chrome.tabs.Tab)
    await expect(first).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-old-job',
      status: 'error',
      code: 'ZKTLS_CAPTURE_FAILED',
    })

    const second = proveZkTlsSession({
      correlationId: 'v4-new-job',
      sessionId: 's1',
      connectorId: 'product-volume',
    })
    await vi.waitFor(() => expect(chrome.tabs.update).toHaveBeenCalledTimes(2))
    expect(removed).toHaveLength(2)
    resolveOldCheck?.(false)
    await vi.waitFor(() => expect(contains).toHaveBeenCalledTimes(3))
    expect(removeRemoved).toHaveBeenCalledTimes(1)

    removed[1]?.({ origins: ['https://*/*'] })
    removed[1]?.({ origins: ['https://*/*'] })
    await vi.waitFor(() => expect(contains).toHaveBeenCalledTimes(5))
    await expect(second).resolves.toEqual({
      type: 'zktls-prove-result',
      correlationId: 'v4-new-job',
      status: 'error',
      code: 'PERMISSION_DENIED',
    })
    expect(removeRemoved).toHaveBeenCalledTimes(2)
  })
})
