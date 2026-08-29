const MAX_V4_WIRE_BYTES = 65_536

function fail(): never {
  throw new Error('zkTLS V4 response is invalid.')
}

function hex(byte: number): bigint {
  if (byte >= 0x30 && byte <= 0x39) return BigInt(byte - 0x30)
  if (byte >= 0x41 && byte <= 0x46) return BigInt(byte - 0x41 + 10)
  if (byte >= 0x61 && byte <= 0x66) return BigInt(byte - 0x61 + 10)
  return fail()
}

export function v4DechunkBody(
  input: Uint8Array,
  maxWireBytes: number,
): Uint8Array {
  if (
    !(input instanceof Uint8Array) ||
    !Number.isInteger(maxWireBytes) ||
    maxWireBytes < 1 ||
    maxWireBytes > MAX_V4_WIRE_BYTES ||
    input.length === 0 ||
    input.length > maxWireBytes
  )
    return fail()

  const ranges: { start: number; end: number }[] = []
  const max = BigInt(maxWireBytes)
  let offset = 0
  let total = 0
  while (offset < input.length) {
    let size = 0n
    let digits = 0
    while (offset < input.length && input[offset] !== 0x0d) {
      size = size * 16n + hex(input[offset]!)
      if (size > max) return fail()
      digits += 1
      offset += 1
    }
    if (digits === 0 || input[offset] !== 0x0d || input[offset + 1] !== 0x0a)
      return fail()
    offset += 2

    if (size === 0n) {
      if (
        ranges.length === 0 ||
        input[offset] !== 0x0d ||
        input[offset + 1] !== 0x0a ||
        offset + 2 !== input.length
      )
        return fail()
      const body = new Uint8Array(total)
      let bodyOffset = 0
      for (const range of ranges) {
        body.set(input.subarray(range.start, range.end), bodyOffset)
        bodyOffset += range.end - range.start
      }
      return body
    }

    const length = Number(size)
    const end = offset + length
    if (
      end + 2 > input.length ||
      input[end] !== 0x0d ||
      input[end + 1] !== 0x0a
    )
      return fail()
    ranges.push({ start: offset, end })
    total += length
    offset = end + 2
  }
  return fail()
}
