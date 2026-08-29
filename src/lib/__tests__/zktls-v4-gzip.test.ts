import { describe, expect, test, vi } from 'vitest'
import { v4GunzipJson } from '@/lib/zktls/v4-gzip'

const encoder = new TextEncoder()

function fixedBytes(base64: string): Uint8Array {
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
}

const GZIP_JSON_FIXTURE = fixedBytes(
  'H4sIAAAAAAAAE6tWKkvMKU1VslLKz1aqBQCpVgT8DgAAAA==',
)
const GZIP_A_FIXTURE = fixedBytes('H4sIAAAAAAAAE3MEAIue2dMBAAAA')
const TWO_MEMBER_GZIP_FIXTURE = fixedBytes(
  'H4sIAAAAAAAAE6tWKk/MyUktUbJSys9WqgUA1Nr5EA8AAAAfiwgAAAAAAAATAwAAAAAAAAAAAA==',
)
const OPTIONAL_FHCRC_GZIP_FIXTURE = fixedBytes(
  'H4sIHgAAAAAAEwMAAQIDcGF5bG9hZC5qc29uAHByb2R1Y3Qtemt0bHMAEnirVipPzMlJLVGyUsrPVqoFANTa+RAPAAAA',
)
const DEFLATE_MAGIC_GZIP_FIXTURE = fixedBytes(
  'H4sIAAAAAAAEEwEKAPX/eyJ4IjoiH4sifQq+TxQKAAAA',
)
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

function captureDecompressionChunks(
  outputs: Record<'deflate-raw' | 'gzip', readonly Uint8Array[]>,
): Uint8Array[] {
  const retained: Uint8Array[] = []
  class CapturingDecompressionStream {
    readonly readable: ReadableStream<Uint8Array<ArrayBuffer>>
    readonly writable: WritableStream<BufferSource>

    constructor(format: 'deflate-raw' | 'gzip') {
      const stream = new TransformStream<BufferSource, Uint8Array<ArrayBuffer>>(
        {
          transform(_input, controller) {
            for (const output of outputs[format]) {
              const chunk = new Uint8Array(output)
              retained.push(chunk)
              controller.enqueue(chunk)
            }
          },
        },
      )
      this.readable = stream.readable
      this.writable = stream.writable
    }
  }
  vi.stubGlobal('DecompressionStream', CapturingDecompressionStream)
  return retained
}

describe('V4 bounded gzip decoder', () => {
  test('zeroes both decompression passes without clearing the returned copy', async () => {
    const retained = captureDecompressionChunks({
      'deflate-raw': [Uint8Array.of(1, 2, 3)],
      gzip: [encoder.encode('{"value":'), encoder.encode('"ok"}')],
    })
    try {
      const decoded = await v4GunzipJson(GZIP_JSON_FIXTURE, 14)

      expect(decoded).toEqual(encoder.encode('{"value":"ok"}'))
      expect(decoded.some((byte) => byte !== 0)).toBe(true)
      expect(retained).toHaveLength(3)
      expect(retained.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
        true,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('zeroes retained chunks when decoded output exceeds its cap', async () => {
    const retained = captureDecompressionChunks({
      'deflate-raw': [Uint8Array.of(1, 2, 3)],
      gzip: [encoder.encode('ab'), encoder.encode('cd')],
    })
    try {
      await expect(v4GunzipJson(GZIP_JSON_FIXTURE, 3)).rejects.toThrow(INVALID)
      expect(retained).toHaveLength(3)
      expect(retained.every((chunk) => chunk.every((byte) => byte === 0))).toBe(
        true,
      )
    } finally {
      vi.unstubAllGlobals()
    }
  })

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

  test('rejects two concatenated valid gzip members', async () => {
    await expect(v4GunzipJson(TWO_MEMBER_GZIP_FIXTURE, 65_536)).rejects.toThrow(
      INVALID,
    )
  })

  test('accepts the backend fixture with every optional gzip header field', async () => {
    await expect(
      v4GunzipJson(OPTIONAL_FHCRC_GZIP_FIXTURE, 65_536),
    ).resolves.toEqual(encoder.encode('{"wallet":"ok"}'))
  })

  test('does not mistake gzip magic bytes inside deflate data for a member', async () => {
    await expect(
      v4GunzipJson(DEFLATE_MAGIC_GZIP_FIXTURE, 65_536),
    ).resolves.toEqual(
      Uint8Array.of(123, 34, 120, 34, 58, 34, 31, 139, 34, 125),
    )
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
