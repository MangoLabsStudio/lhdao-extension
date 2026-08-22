import { describe, expect, test } from 'vitest'
import type { CapturedRequest } from '../zktls/capture'
import type { V4Connector } from '../zktls/interpreter'
import { v4RequestDisclosureRanges } from '../zktls/v4-disclosure'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function connector(method: 'GET' | 'POST' = 'POST'): V4Connector {
  return {
    interpreter_version: 4,
    connector_id: 'public-query',
    revision: 1,
    disabled: false,
    purpose: 'METRIC',
    expires_at: '2030-01-01T00:00:00.000Z',
    page_origin: 'https://app.example.com',
    origin: 'https://api.example.com',
    request: {
      method,
      matcher: {
        path: { kind: 'exact', value: '/v1/query' },
        query: {
          required: { account: 'acct-1' },
          optional: {},
          capture: {},
        },
        resource_types: ['main_frame', 'xmlhttprequest', 'fetch'],
      },
      ...(method === 'POST'
        ? {
            body: { account: 'acct-1' },
            content_type: 'application/json' as const,
          }
        : {}),
      replay: 'EXACT_CAPTURE',
      semantics: 'READ_ONLY_QUERY',
      secret_headers: [],
      max_sent_data: 8192,
      max_recv_data: 65536,
    },
    variables: [],
    resolved_variables: {},
    response_format: 'json',
    response_status: 200,
    disclosure: {
      key_paths: ['$.ok'],
      scalar_paths: ['$.ok'],
      collection_paths: [],
      max_elements: 200,
    },
    pipelines: [{ output: 'ok', sourcePath: '$.ok', cast: 'BOOLEAN' }],
    verifier_profile_id: 'lighthouse-v1',
  }
}

const path = '/v1/query?account=acct-1'
const body = '{"account":"acct-1","note":"exact bytes"}'

function capture(method: 'GET' | 'POST' = 'POST'): CapturedRequest {
  return {
    path,
    ...(method === 'POST'
      ? {
          method,
          body,
          content_type: 'application/json' as const,
        }
      : {}),
    secrets: {},
    resource_type: 'fetch',
    capturedVariables: {},
  }
}

function request(
  method: 'GET' | 'POST' = 'POST',
  options: {
    origin?: string
    headers?: readonly string[]
    body?: string
    path?: string
  } = {},
): Uint8Array {
  const origin = new URL(options.origin ?? 'https://api.example.com')
  const requestBody = options.body ?? (method === 'POST' ? body : '')
  const headers =
    options.headers ??
    (method === 'POST'
      ? [
          `Host: ${origin.host}`,
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(requestBody).length}`,
          'Connection: close',
        ]
      : [`Host: ${origin.host}`, 'Connection: close'])
  return encoder.encode(
    `${method} ${options.path ?? path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${requestBody}`,
  )
}

function disclosed(
  bytes: Uint8Array,
  ranges: readonly { start: number; end: number }[],
) {
  return ranges.map(({ start, end }) => bytes.slice(start, end))
}

describe('complete V4 public request disclosure', () => {
  test('reveals the complete immutable POST capture in one range', () => {
    const sent = request()
    const ranges = v4RequestDisclosureRanges(sent, connector(), capture())

    expect(ranges).toEqual([{ start: 0, end: sent.length }])
    expect(disclosed(sent, ranges)).toEqual([sent])
  })

  test('accepts the exact POST headers in any order', () => {
    const sent = request('POST', {
      headers: [
        'Connection: close',
        `Content-Length: ${encoder.encode(body).length}`,
        'Host: api.example.com',
        'Content-Type: application/json',
      ],
    })

    expect(v4RequestDisclosureRanges(sent, connector(), capture())).toEqual([
      { start: 0, end: sent.length },
    ])
  })

  test('accepts the exact GET transcript without content headers or a body', () => {
    const sent = request('GET')

    expect(
      v4RequestDisclosureRanges(sent, connector('GET'), capture('GET')),
    ).toEqual([{ start: 0, end: sent.length }])
  })

  test('matches canonical default, nondefault, and IPv6 HTTPS authorities', () => {
    const cases = [
      ['https://api.example.com', 'api.example.com'],
      ['https://api.example.com', 'api.example.com:443'],
      ['https://api.example.com:8443', 'api.example.com:8443'],
      ['https://[2001:4860:4860::8888]:8443', '[2001:4860:4860::8888]:8443'],
    ] as const

    for (const [origin, host] of cases) {
      const config = connector('GET')
      config.origin = origin
      const sent = request('GET', {
        origin,
        headers: [`Host: ${host}`, 'Connection: close'],
      })
      expect(() =>
        v4RequestDisclosureRanges(sent, config, capture('GET')),
      ).not.toThrow()
    }
  })

  test.each([
    ['wrong method', request('GET')],
    ['wrong path', request('POST', { path: '/v1/other?account=acct-1' })],
    [
      'wrong HTTP version',
      encoder.encode(
        decoder.decode(request()).replace(' HTTP/1.1\r\n', ' HTTP/1.0\r\n'),
      ),
    ],
    [
      'credential header',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Cookie: secret',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'browser metadata',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Origin: https://app.example.com',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'transfer encoding',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Transfer-Encoding: chunked',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'content encoding',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Content-Encoding: identity',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'duplicate header',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'host: api.example.com',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'folded header',
      request('POST', {
        headers: [
          'Host: api.example.com',
          '\tcontinued',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'invalid header token',
      request('POST', {
        headers: [
          'Bad Header: value',
          'Host: api.example.com',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'wrong content length',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Content-Type: application/json',
          'Content-Length: 1',
          'Connection: close',
        ],
      }),
    ],
    [
      'missing content length',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Content-Type: application/json',
          'Connection: close',
        ],
      }),
    ],
    [
      'wrong content type',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Content-Type: text/plain',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'missing host',
      request('POST', {
        headers: [
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    [
      'wrong connection',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Content-Type: application/json',
          `Content-Length: ${encoder.encode(body).length}`,
          'Connection: Close',
        ],
      }),
    ],
    [
      'noncanonical content length',
      request('POST', {
        headers: [
          'Host: api.example.com',
          'Content-Type: application/json',
          `Content-Length: 0${encoder.encode(body).length}`,
          'Connection: close',
        ],
      }),
    ],
    ['altered body', request('POST', { body: '{"account":"acct-2"}' })],
    ['trailing bytes', encoder.encode(`${decoder.decode(request())}x`)],
  ])('rejects %s', (_, sent) => {
    expect(() =>
      v4RequestDisclosureRanges(sent, connector(), capture()),
    ).toThrow()
  })

  test.each([
    [
      'content headers',
      ['Host: api.example.com', 'Content-Length: 0', 'Connection: close'],
    ],
    ['body', ['Host: api.example.com', 'Connection: close']],
  ])('rejects GET with %s', (kind, headers) => {
    const sent = request('GET', {
      headers,
      ...(kind === 'body' ? { body: '{}' } : {}),
    })
    expect(() =>
      v4RequestDisclosureRanges(sent, connector('GET'), capture('GET')),
    ).toThrow()
  })

  test.each([
    'evil.example.com',
    'api.example.com.',
    'api.example.com:0443',
    'api.example.com:8443',
  ])('rejects noncanonical or wrong Host %s', (host) => {
    const sent = request('GET', {
      headers: [`Host: ${host}`, 'Connection: close'],
    })
    expect(() =>
      v4RequestDisclosureRanges(sent, connector('GET'), capture('GET')),
    ).toThrow()
  })

  test('rejects NUL, invalid UTF-8, and bytes beyond the signed limit', () => {
    const nul = request()
    nul[nul.indexOf('c'.charCodeAt(0))] = 0
    const invalidUtf8 = new Uint8Array([...request(), 0xff])
    const oversized = new Uint8Array(8193).fill(1)

    for (const sent of [nul, invalidUtf8, oversized]) {
      expect(() =>
        v4RequestDisclosureRanges(sent, connector(), capture()),
      ).toThrow()
    }
  })
})
