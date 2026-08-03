import { describe, expect, it } from 'vitest'
import {
  type BinanceProbeObservation,
  buildProbeObservation,
  findProbeTarget,
  parseProbeObservation,
  parseProbeObservationMessage,
  parseProbeTargetConfigMessage,
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

  it('does not authorize a rounded unsafe numeric target alias', () => {
    const aliasTargets = [{ kind: 'CONTENT', id: '9007199254740992' }] as const
    const rounded = Number('9007199254740993')

    expect(String(rounded)).toBe('9007199254740992')
    expect(findProbeTarget({ postId: rounded }, aliasTargets)).toBeNull()
    expect(
      buildProbeObservation({
        ...validBuildArgs(),
        request: { postId: rounded },
        targets: aliasTargets,
      }),
    ).toBeNull()
    expect(
      findProbeTarget({ postId: '9007199254740992' }, aliasTargets),
    ).toEqual(aliasTargets[0])
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

  it('templates dynamic object keys without retaining private key text', () => {
    const privateKeys = [
      'alice@example.com',
      '@short-handle',
      '123456789',
      '12 Private Street',
      '0x1234567890abcdef1234567890abcdef12345678',
    ]
    const request = Object.fromEntries([
      ['postId', '335389698745313'],
      ...privateKeys.map((key) => [key, true]),
    ])
    const shape = sanitizeProbeValue(request, targets) as Record<
      string,
      unknown
    >
    const serializedShape = JSON.stringify(shape)

    for (const privateKey of privateKeys) {
      expect(serializedShape).not.toContain(privateKey)
    }
    expect(Object.keys(shape).filter((key) => key !== 'postId')).toEqual([
      '<key:string:42:0>',
      '<key:string:17:1>',
      '<key:digits:9:2>',
      '<key:string:13:3>',
      '<key:string:17:4>',
    ])

    const observation = buildProbeObservation({
      ...validBuildArgs(),
      request,
    })
    expect(parseProbeObservation(observation)).toEqual(observation)
    const serializedObservation = JSON.stringify(observation)
    for (const privateKey of privateKeys) {
      expect(serializedObservation).not.toContain(privateKey)
    }
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
    ['alice%40example.com', ':segment'],
    ['alice', ':segment'],
    ['alice@example.com', ':segment'],
    ['private%20comment', ':segment'],
    ['0x1234567890abcdef1234567890abcdef12345678', ':id'],
  ])('templates a private path segment: %s', (segment, template) => {
    const observation = buildProbeObservation({
      ...validBuildArgs(),
      url: `https://www.binance.com/bapi/post/${segment}/detail`,
    })

    expect(observation?.path).toBe(`/bapi/post/${template}/detail`)
    expect(parseProbeObservation(observation)).toEqual(observation)
    expect(JSON.stringify(observation)).not.toContain(segment)
    expect(JSON.stringify(observation)).not.toContain(
      decodeURIComponent(segment),
    )
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

  it('templates an overlong private path segment without retaining it', () => {
    const privateSegment = '%E4%B8%AD'.repeat(60)
    const observation = buildProbeObservation({
      ...validBuildArgs(),
      url: `https://www.binance.com/bapi/${privateSegment}`,
    })
    expect(observation?.path).toBe('/bapi/:segment')
    expect(JSON.stringify(observation)).not.toContain(privateSegment)
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
    const longKeyShape = sanitizeProbeValue(longKeys, targets)
    expect(JSON.stringify(longKeyShape).length).toBeLessThanOrEqual(16_384)
    expect(JSON.stringify(longKeyShape)).not.toContain('x'.repeat(300))
  })

  it.each([
    'sanitize',
    'find',
  ])('does not use a full key sort before bounded %s traversal', (operation) => {
    let reads = 0
    const wide: Record<string, unknown> = {}
    for (let i = 0; i < 200; i += 1) {
      Object.defineProperty(wide, `dynamic-${i}`, {
        enumerable: true,
        get() {
          reads += 1
          if (i >= 80) throw new Error('read beyond key bound')
          return false
        },
      })
    }

    expect(() =>
      operation === 'sanitize'
        ? sanitizeProbeValue(wide, targets)
        : findProbeTarget(wide, targets),
    ).not.toThrow()
    expect(reads).toBe(80)
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
      '<key:string:6:0>': '<unsupported>',
      '<key:string:8:1>': { '<key:string:4:0>': '<circular>' },
      '<key:string:2:2>': '<unsupported>',
      '<key:string:6:3>': '<unsupported>',
      '<key:string:9:4>': '<unsupported>',
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
  function observationEnvelopeOfLength(length: number) {
    const envelope = (digits: number) => ({
      __lhBinanceProbe: true,
      observation: validObservation({
        requestShape: { text: `<string:${'1'.repeat(digits)}>` },
      }),
    })
    const baseLength = JSON.stringify(envelope(1)).length - 1
    const value = envelope(length - baseLength)
    expect(JSON.stringify(value)).toHaveLength(length)
    return value
  }

  it('enforces the serialized size limit on the complete message envelope', () => {
    const atLimit = observationEnvelopeOfLength(16_384)
    const overLimit = observationEnvelopeOfLength(16_385)

    expect(parseProbeObservation(atLimit.observation)).not.toBeNull()
    expect(parseProbeObservation(overLimit.observation)).not.toBeNull()
    expect(parseProbeObservationMessage(atLimit)).not.toBeNull()
    expect(parseProbeObservationMessage(overLimit)).toBeNull()
  })

  it.each([
    'requestShape',
    'responseShape',
  ] as const)('rejects oversized %s hidden by a non-enumerable observation toJSON', (field) => {
    const oversizedShape = {
      text: `<string:${'1'.repeat(20_000)}>`,
    }
    const observation = validObservation({ [field]: oversizedShape })
    let toJsonCalls = 0
    Object.defineProperty(observation, 'toJSON', {
      enumerable: false,
      value: () => {
        toJsonCalls += 1
        return validObservation()
      },
    })

    expect(JSON.stringify(oversizedShape).length).toBeGreaterThan(16_384)
    expect(JSON.stringify(observation).length).toBeLessThan(16_384)
    expect(toJsonCalls).toBe(1)
    toJsonCalls = 0
    expect(parseProbeObservation(observation)).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
      }),
    ).toBeNull()
    expect(toJsonCalls).toBe(0)
  })

  it.each([
    'requestShape',
    'responseShape',
  ] as const)('rejects oversized %s without invoking inherited Object.prototype.toJSON', (field) => {
    const observation = validObservation({
      [field]: { text: `<string:${'1'.repeat(20_000)}>` },
    })
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON')
    let calls = 0
    let parsed: BinanceProbeObservation | null = null
    let parsedMessage: BinanceProbeObservation | null = null
    try {
      Object.defineProperty(Object.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          calls += 1
          return null
        },
      })
      parsed = parseProbeObservation(observation)
      parsedMessage = parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation,
      })
    } finally {
      if (previous) {
        Object.defineProperty(Object.prototype, 'toJSON', previous)
      } else {
        Reflect.deleteProperty(Object.prototype, 'toJSON')
      }
    }

    expect(parsed).toBeNull()
    expect(parsedMessage).toBeNull()
    expect(calls).toBe(0)
  })

  it('rejects inherited Array.prototype and custom array-prototype toJSON', () => {
    const previous = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON')
    let calls = 0
    let inherited: BinanceProbeObservation | null = null
    try {
      Object.defineProperty(Array.prototype, 'toJSON', {
        configurable: true,
        value: () => {
          calls += 1
          return null
        },
      })
      inherited = parseProbeObservation(
        validObservation({ requestShape: [true] }),
      )
    } finally {
      if (previous) {
        Object.defineProperty(Array.prototype, 'toJSON', previous)
      } else {
        Reflect.deleteProperty(Array.prototype, 'toJSON')
      }
    }

    const customPrototype = Object.create(Array.prototype)
    Object.defineProperty(customPrototype, 'toJSON', {
      configurable: true,
      get: () => {
        calls += 1
        return () => null
      },
    })
    const customArray = [true]
    Object.setPrototypeOf(customArray, customPrototype)
    const custom = parseProbeObservation(
      validObservation({ responseShape: customArray }),
    )

    expect(inherited).toBeNull()
    expect(custom).toBeNull()
    expect(calls).toBe(0)
  })

  it('fails closed when prototype descriptor inspection throws', () => {
    const hostilePrototype = new Proxy(Object.create(Array.prototype), {
      getOwnPropertyDescriptor() {
        throw new Error('hostile descriptor trap')
      },
    })
    const shape = [true]
    Object.setPrototypeOf(shape, hostilePrototype)
    let parsed: BinanceProbeObservation | null | undefined

    expect(() => {
      parsed = parseProbeObservation(validObservation({ requestShape: shape }))
    }).not.toThrow()
    expect(parsed).toBeNull()
  })

  it('continues accepting plain, null-prototype, and ordinary array shapes', () => {
    const requestShape = Object.assign(Object.create(null), {
      data: [true, null, '<unsupported>'],
    })
    const value = Object.assign(
      Object.create(null),
      validObservation({
        target: Object.assign(Object.create(null), targets[0]),
        requestShape,
      }),
    )

    expect(parseProbeObservation(value)).toEqual(value)
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation: value,
      }),
    ).toEqual(value)
  })

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

  it('accepts canonical key markers and rejects raw dynamic keys', () => {
    const marked = validObservation({
      requestShape: { '<key:string:17:0>': true },
    })
    expect(parseProbeObservation(marked)).toEqual(marked)
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation: marked,
      }),
    ).toEqual(marked)

    const raw = validObservation({
      requestShape: { 'alice@example.com': true },
    })
    expect(parseProbeObservation(raw)).toBeNull()
    expect(
      parseProbeObservationMessage({
        __lhBinanceProbe: true,
        observation: raw,
      }),
    ).toBeNull()
  })

  it.each([
    ['raw string', { requestShape: { text: 'private comment' } }],
    ['raw number', { responseShape: { count: 42 } }],
    ['unknown marker', { requestShape: { text: '<redacted>' } }],
    ['sensitive key', { requestShape: { accessToken: '<string:6>' } }],
    [
      'out-of-range key-marker ordinal',
      { requestShape: { '<key:string:4:80>': true } },
    ],
    [
      'too many keys',
      {
        requestShape: Object.fromEntries([
          ...Array.from({ length: 80 }, (_, i) => [
            `<key:string:${i + 1}:${i}>`,
            true,
          ]),
          ['data', true],
        ]),
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
    for (let i = 0; i < 8; i += 1) deep = { nested: deep }
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

    const largeMarkerObject = () =>
      Object.fromEntries(
        Array.from({ length: 80 }, (_, i) => [
          `<key:string:${i + 1}${'0'.repeat(99)}:${i}>`,
          '<unsupported>',
        ]),
      )
    const largeShape = {
      data: largeMarkerObject(),
      result: largeMarkerObject(),
    }
    expect(JSON.stringify(largeShape).length).toBeGreaterThan(16_384)
    expect(
      parseProbeObservation(validObservation({ requestShape: largeShape })),
    ).toBeNull()
  })

  it('rejects an observation whose individually valid shapes exceed the total budget', () => {
    const largeShape = Object.fromEntries(
      Array.from({ length: 80 }, (_, i) => [
        `<key:string:${i + 1}${'0'.repeat(75)}:${i}>`,
        '<unsupported>',
      ]),
    )
    expect(JSON.stringify(largeShape).length).toBeLessThan(16_384)
    const value = validObservation({
      requestShape: largeShape,
      responseShape: largeShape,
    })
    expect(JSON.stringify(value).length).toBeGreaterThan(16_384)

    expect(parseProbeObservation(value)).toBeNull()
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

  it.each([
    'alice',
    'alice@example.com',
    'private%20comment',
  ])('rejects an untemplated private path segment: %s', (segment) => {
    expect(
      parseProbeObservation(
        validObservation({ path: `/bapi/post/${segment}/detail` }),
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

describe('Binance Square probe target config parser', () => {
  it('accepts an exact, dense, deduplicated target envelope', () => {
    expect(
      parseProbeTargetConfigMessage({
        __lhBinanceProbeConfig: true,
        targets: [
          { kind: 'CONTENT', id: '335389698745313' },
          { kind: 'AUTHOR', id: '123456' },
          { kind: 'CONTENT', id: '335389698745313' },
        ],
      }),
    ).toEqual([
      { kind: 'CONTENT', id: '335389698745313' },
      { kind: 'AUTHOR', id: '123456' },
    ])
  })

  it.each([
    ['missing marker', { targets }],
    [
      'extra wrapper key',
      { __lhBinanceProbeConfig: true, targets, rawBody: 'secret' },
    ],
    [
      'invalid target id',
      {
        __lhBinanceProbeConfig: true,
        targets: [{ kind: 'CONTENT', id: '12345' }],
      },
    ],
    [
      'invalid target kind',
      {
        __lhBinanceProbeConfig: true,
        targets: [{ kind: 'USER', id: '123456' }],
      },
    ],
    [
      'extra target key',
      {
        __lhBinanceProbeConfig: true,
        targets: [{ kind: 'CONTENT', id: '123456', token: 'secret' }],
      },
    ],
    [
      'oversized list',
      {
        __lhBinanceProbeConfig: true,
        targets: Array.from({ length: 500 }, (_, index) => ({
          kind: 'CONTENT',
          id: String(index).padStart(32, '1'),
        })),
      },
    ],
  ])('rejects %s', (_name, value) => {
    expect(parseProbeTargetConfigMessage(value)).toBeNull()
  })

  it('rejects sparse and inherited target data without throwing', () => {
    const sparse = Array(1)
    const inherited = Object.create({ kind: 'CONTENT', id: '123456' })

    expect(
      parseProbeTargetConfigMessage({
        __lhBinanceProbeConfig: true,
        targets: sparse,
      }),
    ).toBeNull()
    expect(
      parseProbeTargetConfigMessage({
        __lhBinanceProbeConfig: true,
        targets: [inherited],
      }),
    ).toBeNull()
  })
})
