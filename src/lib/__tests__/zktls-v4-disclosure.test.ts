import { describe, expect, test } from 'vitest'
import type { CapturedRequest } from '../zktls/capture'
import type { V4Connector } from '../zktls/interpreter'
import {
  v4PublicRequestDetails,
  v4RequestDisclosureRanges,
  v4ResponseDisclosureRanges,
} from '../zktls/v4-disclosure'

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

function gzipConnector(method: 'GET' | 'POST' = 'POST'): V4Connector {
  return {
    ...connector(method),
    response_content_encoding: 'gzip',
    max_decoded_data: 65_536,
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
  test.each([
    {
      origin: 'https://api.example.com:8443',
      method: 'GET' as const,
      path: '/v1/%E8%B7%AF%E5%BE%84?account=%E8%B4%A6%E6%88%B7',
    },
    {
      origin: 'https://[2001:4860:4860::8888]:8443',
      method: 'POST' as const,
      path: '/v1/query?note=%F0%9F%9A%80',
      body: '{"note":"火箭🚀"}',
      contentType: 'application/json' as const,
    },
  ])('measures the exact replay bytes for $origin $method', ({
    origin,
    method,
    path,
    body,
    contentType,
  }) => {
    const details = v4PublicRequestDetails({
      origin,
      method,
      path,
      ...(body ? { body, contentType } : {}),
    })
    const bodyBytes = body ? encoder.encode(body) : new Uint8Array()
    const expected = encoder.encode(
      `${method} ${path} HTTP/1.1\r\n` +
        `host: ${new URL(origin).host}\r\n` +
        'connection: close\r\n' +
        (method === 'POST'
          ? `content-type: application/json\r\ncontent-length: ${bodyBytes.length}\r\n`
          : '') +
        '\r\n',
    ).length

    expect(details.sentByteLength).toBe(expected + bodyBytes.length)
    expect(details.host).toBe(new URL(origin).host)
    expect(details.body).toEqual(bodyBytes.length ? bodyBytes : undefined)
  })

  test('reveals the complete immutable POST capture in one range', () => {
    const sent = request()
    const ranges = v4RequestDisclosureRanges(sent, connector(), capture())

    expect(ranges).toEqual([{ start: 0, end: sent.length }])
    expect(disclosed(sent, ranges)).toEqual([sent])
  })

  test.each([
    'GET',
    'POST',
  ] as const)('derives and discloses one exact gzip accept header for %s', (method) => {
    const requestBody = method === 'POST' ? body : ''
    const headers = [
      'Host: api.example.com',
      'Connection: close',
      'Accept-Encoding: gzip',
      ...(method === 'POST'
        ? [
            'Content-Type: application/json',
            `Content-Length: ${encoder.encode(requestBody).length}`,
          ]
        : []),
    ]
    const sent = request(method, { headers })
    const details = v4PublicRequestDetails({
      origin: 'https://api.example.com',
      method,
      path,
      contentEncoding: 'gzip',
      ...(method === 'POST'
        ? { body: requestBody, contentType: 'application/json' as const }
        : {}),
    })

    expect(details.contentEncoding).toBe('gzip')
    expect(details.sentByteLength).toBe(sent.length)
    expect(
      v4RequestDisclosureRanges(sent, gzipConnector(method), capture(method)),
    ).toEqual([{ start: 0, end: sent.length }])
  })

  test.each([
    ['missing', []],
    ['duplicate', ['Accept-Encoding: gzip', 'accept-encoding: gzip']],
    ['wrong case', ['Accept-Encoding: GZIP']],
    ['combined', ['Accept-Encoding: gzip, br']],
  ])('rejects a %s gzip accept header', (_, acceptHeaders) => {
    const sent = request('GET', {
      headers: ['Host: api.example.com', 'Connection: close', ...acceptHeaders],
    })

    expect(() =>
      v4RequestDisclosureRanges(sent, gzipConnector('GET'), capture('GET')),
    ).toThrow()
  })

  test('keeps identity request bytes unchanged and rejects ambient gzip', () => {
    const input = {
      origin: 'https://api.example.com',
      method: 'GET' as const,
      path,
    }
    const details = v4PublicRequestDetails(input)
    const exactIdentity = request('GET')
    const ambientGzip = request('GET', {
      headers: [
        'Host: api.example.com',
        'Connection: close',
        'Accept-Encoding: gzip',
      ],
    })

    expect(details.sentByteLength).toBe(exactIdentity.length)
    expect(Object.hasOwn(details, 'contentEncoding')).toBe(false)
    expect(() =>
      v4RequestDisclosureRanges(ambientGzip, connector('GET'), capture('GET')),
    ).toThrow()
  })

  test('counts the derived gzip header against the signed sent limit', () => {
    const base = v4PublicRequestDetails({
      origin: 'https://api.example.com',
      method: 'GET',
      path: '/',
    })
    const cappedPath = `/${'x'.repeat(8192 - base.sentByteLength)}`
    const identity = v4PublicRequestDetails({
      origin: 'https://api.example.com',
      method: 'GET',
      path: cappedPath,
    })
    const gzip = v4PublicRequestDetails({
      origin: 'https://api.example.com',
      method: 'GET',
      path: cappedPath,
      contentEncoding: 'gzip',
    })

    expect(identity.sentByteLength).toBe(8192)
    expect(gzip.sentByteLength).toBeGreaterThan(8192)
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

function response(
  body: string | Uint8Array,
  options: { startLine?: string; headers?: readonly string[] } = {},
): Uint8Array {
  const bytes = typeof body === 'string' ? encoder.encode(body) : body
  const head = encoder.encode(
    `${options.startLine ?? 'HTTP/1.1 200 OK'}\r\n${(
      options.headers ?? [
        'Content-Type: application/json',
        `Content-Length: ${bytes.length}`,
        'Date: Fri, 22 Aug 2026 00:00:00 GMT',
        'Server: example',
      ]
    ).join('\r\n')}\r\n\r\n`,
  )
  const result = new Uint8Array(head.length + bytes.length)
  result.set(head)
  result.set(bytes, head.length)
  return result
}

describe('complete V4 JSON response disclosure', () => {
  test('reveals the complete HTTP and JSON transcript in one range', () => {
    const received = response(
      '{"scalar":1.25e2,"object":{"ok":true},"array":[null,"rocket 🚀"]}',
    )

    expect(v4ResponseDisclosureRanges(received, connector())).toEqual([
      { start: 0, end: received.length },
    ])
  })

  test.each([
    'HTTP/1.0 200',
    'HTTP/1.0 200 Public JSON',
    'HTTP/1.1 200',
    'HTTP/1.1 200 OK',
  ])('accepts the backend status-line form %s', (startLine) => {
    const received = response('{"ok":true}', { startLine })
    expect(v4ResponseDisclosureRanges(received, connector())).toEqual([
      { start: 0, end: received.length },
    ])
  })

  test.each([
    ['wrong status', 'HTTP/1.1 201 Created'],
    ['wrong version', 'HTTP/2 200 OK'],
    ['tab reason separator', 'HTTP/1.1 200\tOK'],
    ['non-ASCII reason', 'HTTP/1.1 200 成功'],
  ])('rejects a %s', (_, startLine) => {
    expect(() =>
      v4ResponseDisclosureRanges(
        response('{"ok":true}', { startLine }),
        connector(),
      ),
    ).toThrow()
  })

  test.each([
    ['missing content type', ['Content-Length: 2', 'Connection: close']],
    [
      'wrong content type',
      ['Content-Type: application/json; charset=utf-8', 'Content-Length: 2'],
    ],
    ['missing content length', ['Content-Type: application/json']],
    [
      'noncanonical content length',
      ['Content-Type: application/json', 'Content-Length: 02'],
    ],
    [
      'wrong content length',
      ['Content-Type: application/json', 'Content-Length: 3'],
    ],
    [
      'duplicate header',
      [
        'Content-Type: application/json',
        'content-type: application/json',
        'Content-Length: 2',
      ],
    ],
    [
      'transfer encoding',
      [
        'Content-Type: application/json',
        'Content-Length: 2',
        'Transfer-Encoding: chunked',
      ],
    ],
    [
      'content encoding',
      [
        'Content-Type: application/json',
        'Content-Length: 2',
        'Content-Encoding: identity',
      ],
    ],
    [
      'folded header',
      ['Content-Type: application/json', 'Content-Length: 2', '\tcontinued'],
    ],
    [
      'invalid header token',
      [
        'Content-Type: application/json',
        'Content-Length: 2',
        'Bad Header: value',
      ],
    ],
  ])('rejects %s', (_, headers) => {
    expect(() =>
      v4ResponseDisclosureRanges(response('{}', { headers }), connector()),
    ).toThrow()
  })

  test('rejects control bytes and overlong response headers', () => {
    const control = response('{}', {
      headers: [
        'Content-Type: application/json',
        'Content-Length: 2',
        'X-Control: bad\u0001value',
      ],
    })
    const long = response('{}', {
      headers: [
        'Content-Type: application/json',
        'Content-Length: 2',
        `X-Long: ${'x'.repeat(8193)}`,
      ],
    })
    const many = response('{}', {
      headers: [
        'Content-Type: application/json',
        'Content-Length: 2',
        ...Array.from({ length: 99 }, (_, index) => `X-${index}: ok`),
      ],
    })

    for (const received of [control, long, many]) {
      expect(() => v4ResponseDisclosureRanges(received, connector())).toThrow()
    }
  })

  test.each([
    ['duplicate key', '{"ok":true,"ok":false}'],
    ['duplicate decoded key', '{"ok":true,"\\u006f\\u006b":false}'],
    ['prototype key', '{"__proto__":true}'],
    ['leading zero', '{"value":01}'],
    ['leading plus', '{"value":+1}'],
    ['missing fraction', '{"value":1.}'],
    ['missing exponent', '{"value":1e}'],
    ['lone high surrogate', String.raw`{"value":"\uD800"}`],
    ['lone low surrogate', String.raw`{"value":"\uDC00"}`],
    ['invalid surrogate pair', String.raw`{"value":"\uD800\u0041"}`],
    ['raw string control', '{"value":"bad\u0001value"}'],
    ['trailing data', '{"ok":true}x'],
  ])('rejects JSON with %s', (_, body) => {
    expect(() =>
      v4ResponseDisclosureRanges(response(body), connector()),
    ).toThrow()
  })

  test('rejects BOM, invalid UTF-8, NUL, and empty evidence', () => {
    const bom = response(
      new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{}')]),
    )
    const invalidUtf8 = response(
      new Uint8Array([
        0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d,
      ]),
    )
    const nul = response('{"ok":true}')
    nul[nul.length - 2] = 0

    for (const received of [bom, invalidUtf8, nul, new Uint8Array()]) {
      expect(() => v4ResponseDisclosureRanges(received, connector())).toThrow()
    }
  })

  test('rejects JSON beyond the array, depth, and node limits', () => {
    const array = JSON.stringify(Array.from({ length: 201 }, () => 0))
    let nested = '0'
    for (let depth = 0; depth < 13; depth += 1) nested = `[${nested}]`
    const nodes = `{${Array.from(
      { length: 4096 },
      (_, index) => `"k${index}":0`,
    ).join(',')}}`

    for (const body of [array, nested, nodes]) {
      const received = response(body)
      expect(received.length).toBeLessThanOrEqual(65_536)
      expect(() => v4ResponseDisclosureRanges(received, connector())).toThrow()
    }
  })

  test('enforces the signed dynamic receive bound and the V4 hard cap', () => {
    const received = response('{"ok":true}')
    const limited = connector()
    limited.request.max_recv_data = received.length - 1

    expect(() => v4ResponseDisclosureRanges(received, limited)).toThrow()
    expect(() =>
      v4ResponseDisclosureRanges(new Uint8Array(65_537).fill(1), connector()),
    ).toThrow()
  })
})
