import { describe, expect, it } from 'vitest'
import { canonicalJson, sha256Hex } from '../canonical-json'

describe('canonicalJson', () => {
  it('recursively sorts object keys and omits undefined object fields', () => {
    expect(
      canonicalJson({
        z: 1,
        skip: undefined,
        a: { y: '末', x: '灯塔' },
      }),
    ).toBe('{"a":{"x":"灯塔","y":"末"},"z":1}')
  })

  it('preserves array order and JSON primitive values', () => {
    expect(canonicalJson({ values: [3, true, null, 'x'] })).toBe(
      '{"values":[3,true,null,"x"]}',
    )
  })

  it.each([
    Number.NaN,
    Number.POSITIVE_INFINITY,
    BigInt(1),
    undefined,
    () => 'not json',
    [undefined],
    Array(1),
  ])('rejects non-JSON value %#', (value) => {
    expect(() => canonicalJson(value)).toThrow('non-JSON')
  })

  it('returns a stable SHA-256 hex digest', async () => {
    await expect(
      sha256Hex(canonicalJson({ b: [true, null, '灯塔'], a: 1 })),
    ).resolves.toBe(
      '910848aa2a5f8067d136074ddc3dfd1c5d206ccb9aaab0130fc825da8ee4ec56',
    )
  })
})
