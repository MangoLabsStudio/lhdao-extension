import { describe, expect, test } from 'vitest'
import { v4GunzipJson } from '@/lib/zktls/v4-gzip'

const encoder = new TextEncoder()

function fixedBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

const GZIP_JSON_FIXTURE = fixedBytes(
  'H4sIAAAAAAAAE6tWKkvMKU1VslLKz1aqBQCpVgT8DgAAAA==',
)
const GZIP_A_FIXTURE = fixedBytes('H4sIAAAAAAAAE3MEAIue2dMBAAAA')
const GZIP_B_FIXTURE = fixedBytes('H4sIAAAAAAAAE3MCADHP0EoBAAAA')
const GZIP_65_536_AS_FIXTURE = fixedBytes(
  'H4sIAAAAAAAAE+3BgQAAAACAINb9JRapCgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGr/kSDDAAABAA==',
)
const INVALID = 'V4 gzip response is invalid.'

function concat(...parts: Uint8Array[]): Uint8Array {
  const joined = new Uint8Array(
    parts.reduce((length, part) => length + part.byteLength, 0),
  )
  let offset = 0
  for (const part of parts) {
    joined.set(part, offset)
    offset += part.byteLength
  }
  return joined
}

describe('V4 bounded gzip decoder', () => {
  test('decodes a fixed gzip body at its exact configured limit', async () => {
    await expect(v4GunzipJson(GZIP_JSON_FIXTURE, 14)).resolves.toEqual(
      encoder.encode('{"value":"ok"}'),
    )
  })

  test('accepts the lower and upper decoded-size boundaries', async () => {
    await expect(v4GunzipJson(GZIP_A_FIXTURE, 1)).resolves.toEqual(
      encoder.encode('A'),
    )
    const decoded = await v4GunzipJson(GZIP_65_536_AS_FIXTURE, 65_536)
    expect(decoded).toHaveLength(65_536)
    expect(decoded[0]).toBe(97)
    expect(decoded.at(-1)).toBe(97)
  })

  test('rejects decoded output as soon as it exceeds the configured limit', async () => {
    await expect(v4GunzipJson(GZIP_JSON_FIXTURE, 13)).rejects.toThrow(INVALID)
    await expect(v4GunzipJson(GZIP_65_536_AS_FIXTURE, 65_535)).rejects.toThrow(
      INVALID,
    )
  })

  test('accepts concatenated valid gzip members', async () => {
    await expect(
      v4GunzipJson(concat(GZIP_A_FIXTURE, GZIP_B_FIXTURE), 2),
    ).resolves.toEqual(encoder.encode('AB'))
  })

  test.each([
    ['corrupt input', Uint8Array.of(1, 2, 3)],
    ['truncated input', GZIP_JSON_FIXTURE.slice(0, -1)],
    ['trailing junk', concat(GZIP_JSON_FIXTURE, Uint8Array.of(1, 2, 3))],
    ['trailing NUL padding', concat(GZIP_JSON_FIXTURE, Uint8Array.of(0))],
  ])('fails closed for %s', async (_name, compressed) => {
    await expect(v4GunzipJson(compressed, 65_536)).rejects.toThrow(INVALID)
  })

  test.each([
    0,
    65_537,
    1.5,
    Number.NaN,
  ])('rejects an invalid decoded-size cap: %s', async (limit) => {
    await expect(v4GunzipJson(GZIP_JSON_FIXTURE, limit)).rejects.toThrow(
      INVALID,
    )
  })

  test('maps repeated decode and overflow failures without unhandled work', async () => {
    const attempts = Array.from({ length: 50 }, (_, index) =>
      v4GunzipJson(index % 2 ? Uint8Array.of(1) : GZIP_JSON_FIXTURE, 1),
    )
    const results = await Promise.allSettled(attempts)
    expect(results).toHaveLength(50)
    expect(
      results.every(
        (result) =>
          result.status === 'rejected' && result.reason.message === INVALID,
      ),
    ).toBe(true)
  })
})
