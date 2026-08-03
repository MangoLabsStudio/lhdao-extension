import { describe, expect, it } from 'vitest'
import {
  type BinanceProbeObservation,
  buildProbeObservation,
  findProbeTarget,
  parseProbeObservation,
  parseProbeObservationMessage,
  sanitizeProbeValue,
} from '../binance-square-probe'

const targets = [{ kind: 'CONTENT', id: '335389698745313' }] as const

function validObservation(
  overrides: Partial<BinanceProbeObservation> = {},
): BinanceProbeObservation {
  return {
    id: '123e4567-e89b-42d3-a456-426614174000',
    method: 'POST',
    path: '/bapi/example',
    status: 200,
    target: targets[0],
    requestShape: { postId: '<target:CONTENT>' },
    responseShape: { code: '<digits:6>' },
    capturedAt: '2026-08-03T00:00:00.000Z',
    ...overrides,
  }
}

function validBuildArgs() {
  return {
    url: 'https://www.binance.com/bapi/example',
    method: 'POST',
    status: 200,
    request: { postId: '335389698745313' },
    response: null,
    targets,
    capturedAt: '2026-08-03T00:00:00.000Z',
  }
}

describe('Binance Square probe sanitizer', () => {
  it('matches only an exact configured scalar target in bounded JSON', () => {
    expect(
      findProbeTarget(
        { postId: '335389698745313', text: 'private comment' },
        targets,
      ),
    ).toEqual(targets[0])
    expect(findProbeTarget({ postId: '999' }, targets)).toBeNull()
    expect(findProbeTarget({ postId: 335389698745313 }, targets)).toEqual(
      targets[0],
    )
    expect(findProbeTarget({ token: '335389698745313' }, targets)).toBeNull()

    let tooDeep: unknown = '335389698745313'
    for (let i = 0; i < 7; i += 1) tooDeep = { child: tooDeep }
    expect(findProbeTarget(tooDeep, targets)).toBeNull()
    expect(
      findProbeTarget(
        [null, null, null, null, null, '335389698745313'],
        targets,
      ),
    ).toBeNull()
    expect(
      findProbeTarget(
        Object.fromEntries([
          ...Array.from({ length: 80 }, (_, i) => [`a${i}`, null]),
          ['zTarget', '335389698745313'],
        ]),
        targets,
      ),
    ).toBeNull()
  })

  it('replaces scalar values and drops sensitive keys', () => {
    expect(
      sanitizeProbeValue(
        {
          postId: '335389698745313',
          text: 'private comment',
          ok: true,
          empty: null,
          count: 42,
          nested: { uid: '123456789' },
          authorization: 'Bearer private',
          csrfToken: 'private',
        },
        targets,
      ),
    ).toEqual({
      count: '<number>',
      empty: null,
      nested: { uid: '<digits:9>' },
      ok: true,
      postId: '<target:CONTENT>',
      text: '<string:15>',
    })
  })

  it('builds only a sanitized Binance POST observation', () => {
    const observation = buildProbeObservation({
      url: 'https://www.binance.com/bapi/example?token=secret#private',
      method: 'POST',
      status: 200,
      request: {
        postId: '335389698745313',
        text: 'private comment',
        cookie: 'session-secret',
      },
      response: { code: '000000', data: { id: '987654321' } },
      targets,
      capturedAt: '2026-08-03T00:00:00.000Z',
    })

    expect(observation?.id).toEqual(expect.any(String))
    expect(observation?.path).toBe('/bapi/example')
    expect(observation?.target.id).toBe('335389698745313')
    expect(observation).not.toHaveProperty('headers')
    expect(observation).not.toHaveProperty('cookies')
    expect(observation).not.toHaveProperty('request')
    expect(observation).not.toHaveProperty('response')
    const serialized = JSON.stringify(observation)
    for (const privateValue of [
      'secret',
      'private comment',
      'session-secret',
      '987654321',
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('rejects invalid requests and redacts identifier-like path segments', () => {
    const base = validBuildArgs()

    expect(
      buildProbeObservation({
        ...base,
        url: 'https://www.binance.com/bapi/post/987654321/abcdefghijklmnopqrstuvwx',
      })?.path,
    ).toBe('/bapi/post/:id/:id')
    expect(buildProbeObservation({ ...base, method: 'GET' })).toBeNull()
    expect(buildProbeObservation({ ...base, status: 600 })).toBeNull()
    expect(buildProbeObservation({ ...base, status: 200.5 })).toBeNull()
    expect(
      buildProbeObservation({
        ...base,
        url: 'http://www.binance.com/bapi/example',
      }),
    ).toBeNull()
    expect(
      buildProbeObservation({
        ...base,
        url: 'https://binance.com/bapi/example',
      }),
    ).toBeNull()
    expect(
      buildProbeObservation({
        ...base,
        url: 'https://www.binance.com/api/example',
      }),
    ).toBeNull()
    expect(
      buildProbeObservation({
        ...base,
        request: { postId: '999' },
      }),
    ).toBeNull()
  })

  it('normalizes matching targets to exact public fields', () => {
    const injectedTargets = [
      {
        kind: 'CONTENT' as const,
        id: '335389698745313',
        rawBody: 'private comment',
      },
    ]
    const observation = buildProbeObservation({
      ...validBuildArgs(),
      targets: injectedTargets,
    })

    expect(observation?.target).toEqual({
      kind: 'CONTENT',
      id: '335389698745313',
    })
    expect(Object.keys(observation?.target ?? {})).toEqual(['kind', 'id'])
    expect(JSON.stringify(observation)).not.toContain('private comment')
  })

  it.each([
    ['short id', { kind: 'CONTENT', id: '12345' }],
    ['non-numeric id', { kind: 'AUTHOR', id: '12345x' }],
    ['invalid kind', { kind: 'USER', id: '335389698745313' }],
  ])('rejects an invalid target definition: %s', (_name, target) => {
    expect(
      buildProbeObservation({
        ...validBuildArgs(),
        request: { postId: target.id },
        targets: [target] as never,
      }),
    ).toBeNull()
  })

  it.each([
    ['%39%38%37%36%35%34%33%32%31', '/bapi/post/:id'],
    ['%61'.repeat(24), '/bapi/post/:id'],
  ])('redacts an encoded identifier segment', (segment, expectedPath) => {
    expect(
      buildProbeObservation({
        ...validBuildArgs(),
        url: `https://www.binance.com/bapi/post/${segment}`,
      })?.path,
    ).toBe(expectedPath)
  })

  it('fails closed on a malformed encoded path segment', () => {
    expect(
      buildProbeObservation({
        ...validBuildArgs(),
        url: 'https://www.binance.com/bapi/post/%not-valid',
      }),
    ).toBeNull()
  })

  it('fails closed instead of cutting an overlong encoded path', () => {
    expect(
      buildProbeObservation({
        ...validBuildArgs(),
        url: `https://www.binance.com/bapi/${'%E4%B8%AD'.repeat(60)}`,
      }),
    ).toBeNull()
  })

  it('rejects a non-default Binance HTTPS port', () => {
    expect(
      buildProbeObservation({
        ...validBuildArgs(),
        url: 'https://www.binance.com:444/bapi/example',
      }),
    ).toBeNull()
  })

  it.each([
    '0',
    '2026-08-03T00:00:00Z',
    'not-a-date',
  ])('rejects a noncanonical build timestamp: %s', (capturedAt) => {
    expect(
      buildProbeObservation({ ...validBuildArgs(), capturedAt }),
    ).toBeNull()
  })

  it('builds a parser-valid shape after bounding long keys', () => {
    const longKey = `private-${'x'.repeat(121)}`
    const observation = buildProbeObservation({
      ...validBuildArgs(),
      request: {
        postId: '335389698745313',
        [longKey]: 'private comment',
      },
    })
    expect(parseProbeObservation(observation)).not.toBeNull()
    expect(JSON.stringify(observation)).not.toContain(longKey)
    expect(JSON.stringify(observation)).not.toContain('private comment')
  })

  it('builds a parser-valid truncated shape after node overflow', () => {
    const nodeHeavy = Object.fromEntries([
      ...Array.from({ length: 80 }, (_, i) => [
        `n${String(i).padStart(2, '0')}`,
        Array.from({ length: 5 }, (_, j) => ({
          value: `private-${i}-${j}`,
          ...(i === 79 && j === 4 ? { postId: '335389698745313' } : {}),
        })),
      ]),
    ])
    const observation = buildProbeObservation({
      ...validBuildArgs(),
      request: nodeHeavy,
    })
    expect(parseProbeObservation(observation)).not.toBeNull()
    expect(observation?.requestShape).toEqual({ truncated: true })
    expect(JSON.stringify(observation)).not.toContain('private-')
  })

  it('builds a parser-valid observation for ordinary input', () => {
    const observation = buildProbeObservation(validBuildArgs())
    expect(parseProbeObservation(observation)).toEqual(observation)
  })

  it('bounds depth, object keys, arrays, nodes, and output size', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`k${i}`, { deep: { value: i } }]),
    )
    const wideOut = sanitizeProbeValue(wide, targets) as Record<string, unknown>
    expect(Object.keys(wideOut)).toHaveLength(80)
    expect(JSON.stringify(wideOut).length).toBeLessThanOrEqual(16_384)

    expect(sanitizeProbeValue([1, 2, 3, 4, 5, 6], targets)).toEqual([
      '<number>',
      '<number>',
      '<number>',
      '<number>',
      '<number>',
    ])

    let deep: unknown = 'private'
    for (let i = 0; i < 7; i += 1) deep = { child: deep }
    expect(JSON.stringify(sanitizeProbeValue(deep, targets))).toContain(
      '<max-depth>',
    )

    const nodeHeavy = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `n${i}`,
        Array.from({ length: 5 }, () => ({ value: i })),
      ]),
    )
    expect(sanitizeProbeValue(nodeHeavy, targets)).toEqual({ truncated: true })

    const longKeys = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [`${i}-${'x'.repeat(300)}`, i]),
    )
    expect(sanitizeProbeValue(longKeys, targets)).toEqual({ truncated: true })
  })

  it('handles circular and unsupported values without exposing them', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(
      sanitizeProbeValue(
        {
          bigint: 1n,
          circular,
          fn: () => 'private',
          symbol: Symbol('private'),
          undefined,
        },
        targets,
      ),
    ).toEqual({
      bigint: '<unsupported>',
      circular: { self: '<circular>' },
      fn: '<unsupported>',
      symbol: '<unsupported>',
      undefined: '<unsupported>',
    })
  })

  it('densifies sparse arrays into explicit sanitized markers', () => {
    const sparseRequest: unknown[] = Array(5)
    sparseRequest[4] = { postId: '335389698745313' }
    const expected = [
      '<unsupported>',
      '<unsupported>',
      '<unsupported>',
      '<unsupported>',
      { postId: '<target:CONTENT>' },
    ]

    expect(sanitizeProbeValue(sparseRequest, targets)).toEqual(expected)
    const observation = buildProbeObservation({
      ...validBuildArgs(),
      request: sparseRequest,
    })
    expect(observation?.requestShape).toEqual(expected)
    expect(parseProbeObservation(observation)).not.toBeNull()
  })
})

describe('Binance Square probe observation parser', () => {
  it('accepts only sanitized observation metadata and shapes', () => {
    const observation = validObservation({
      requestShape: {
        array: ['<target:AUTHOR>', '<string:0>', '<number>', true, null],
        bounds: ['<max-depth>', '<max-nodes>', '<circular>', '<unsupported>'],
      },
    })

    expect(parseProbeObservation(observation)).toEqual(observation)
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
      }),
    ).toEqual(observation)
  })

  it.each([
    ['raw string', { requestShape: { text: 'private comment' } }],
    ['raw number', { responseShape: { count: 42 } }],
    ['unknown marker', { requestShape: { text: '<redacted>' } }],
    ['sensitive key', { requestShape: { accessToken: '<string:6>' } }],
    [
      'too many keys',
      {
        requestShape: Object.fromEntries(
          Array.from({ length: 81 }, (_, i) => [`k${i}`, true]),
        ),
      },
    ],
    ['long key', { requestShape: { ['x'.repeat(129)]: true } }],
    [
      'too many array items',
      {
        requestShape: Array.from({ length: 6 }, () => true),
      },
    ],
  ])('rejects a %s in sanitized shapes', (_name, overrides) => {
    expect(parseProbeObservation(validObservation(overrides))).toBeNull()
  })

  it.each([
    ['wrong method', { method: 'GET' }],
    ['query-bearing path', { path: '/bapi/example?token=secret' }],
    ['unredacted numeric path id', { path: '/bapi/post/987654321' }],
    ['unredacted long path id', { path: `/bapi/post/${'a'.repeat(24)}` }],
    ['wrong path', { path: '/api/example' }],
    ['long path', { path: `/bapi/${'x/'.repeat(254)}xx` }],
    ['negative status', { status: -1 }],
    ['large status', { status: 600 }],
    ['fractional status', { status: 200.5 }],
    ['invalid target kind', { target: { kind: 'USER', id: '123456' } }],
    ['short target id', { target: { kind: 'CONTENT', id: '12345' } }],
    ['non-numeric target id', { target: { kind: 'CONTENT', id: '12345x' } }],
    ['long target id', { target: { kind: 'CONTENT', id: '1'.repeat(33) } }],
    ['invalid date', { capturedAt: 'not-a-date' }],
    ['noncanonical date', { capturedAt: '2026-08-03T00:00:00Z' }],
    ['parseable non-date form', { capturedAt: '0' }],
    ['non-UUID id', { id: 'probe-1' }],
    ['non-v4 UUID id', { id: '123e4567-e89b-12d3-a456-426614174000' }],
  ])('rejects malformed metadata: %s', (_name, overrides) => {
    expect(
      parseProbeObservation(
        validObservation(overrides as Partial<BinanceProbeObservation>),
      ),
    ).toBeNull()
  })

  it('rejects excessive shape depth, nodes, and serialized length', () => {
    let deep: unknown = true
    for (let i = 0; i < 8; i += 1) deep = { child: deep }
    expect(
      parseProbeObservation(validObservation({ requestShape: deep })),
    ).toBeNull()

    const nodeHeavy = Array.from({ length: 5 }, () =>
      Array.from({ length: 5 }, () =>
        Array.from({ length: 5 }, () => Array.from({ length: 5 }, () => true)),
      ),
    )
    expect(
      parseProbeObservation(validObservation({ requestShape: nodeHeavy })),
    ).toBeNull()

    const largeShape = Object.fromEntries(
      ['a', 'b'].map((prefix) => [
        prefix,
        Object.fromEntries(
          Array.from({ length: 80 }, (_, i) => [
            `${String(i).padStart(3, '0')}${'x'.repeat(125)}`,
            '<unsupported>',
          ]),
        ),
      ]),
    )
    expect(JSON.stringify(largeShape).length).toBeGreaterThan(16_384)
    expect(
      parseProbeObservation(validObservation({ requestShape: largeShape })),
    ).toBeNull()
  })

  it('rejects non-JSON objects', () => {
    const observation = validObservation({
      requestShape: new Map([['safe', true]]),
    })
    expect(parseProbeObservation(observation)).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
      }),
    ).toBeNull()
  })

  it.each([
    'rawBody',
    '-1',
  ])('rejects an array with a custom enumerable %s property', (key) => {
    const arrayWithCustomProperty: unknown[] = [true]
    Object.assign(arrayWithCustomProperty, { [key]: 'private comment' })
    const observation = validObservation({
      requestShape: arrayWithCustomProperty,
    })
    expect(parseProbeObservation(observation)).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
      }),
    ).toBeNull()
  })

  it('rejects sparse arrays in parsed shapes and messages', () => {
    const sparseShape: unknown[] = Array(5)
    sparseShape[4] = true
    const observation = validObservation({ requestShape: sparseShape })

    expect(parseProbeObservation(observation)).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
      }),
    ).toBeNull()
  })

  it('rejects an unredacted encoded identifier path', () => {
    expect(
      parseProbeObservation(
        validObservation({
          path: '/bapi/post/%39%38%37%36%35%34%33%32%31',
        }),
      ),
    ).toBeNull()
  })

  it('rejects message wrappers that could carry raw payload fields', () => {
    const observation = validObservation()
    expect(parseProbeObservationMessage(observation)).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: false,
        observation,
      }),
    ).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation: { ...observation, rawBody: 'private comment' },
      }),
    ).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
        headers: { authorization: 'secret' },
      }),
    ).toBeNull()
  })
})
