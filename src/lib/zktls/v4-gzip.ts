const INVALID_GZIP = 'V4 gzip response is invalid.'

function gzipPayloadOffset(compressed: Uint8Array): number {
  if (
    compressed.length < 18 ||
    compressed[0] !== 0x1f ||
    compressed[1] !== 0x8b ||
    compressed[2] !== 8 ||
    ((compressed[3] ?? 0) & 0xe0) !== 0
  )
    throw new Error(INVALID_GZIP)

  const flags = compressed[3] ?? 0
  let offset = 10
  if ((flags & 0x04) !== 0) {
    if (offset + 2 > compressed.length) throw new Error(INVALID_GZIP)
    const length =
      (compressed[offset] ?? 0) | ((compressed[offset + 1] ?? 0) << 8)
    offset += 2
    if (offset + length > compressed.length) throw new Error(INVALID_GZIP)
    offset += length
  }
  for (const flag of [0x08, 0x10]) {
    if ((flags & flag) === 0) continue
    const terminator = compressed.indexOf(0, offset)
    if (terminator < 0) throw new Error(INVALID_GZIP)
    offset = terminator + 1
  }
  if ((flags & 0x02) !== 0) offset += 2
  if (offset + 8 >= compressed.length) throw new Error(INVALID_GZIP)
  return offset
}

async function requireSingleMember(
  compressed: Uint8Array<ArrayBuffer>,
  maxDecodedBytes: number,
): Promise<void> {
  const payloadOffset = gzipPayloadOffset(compressed)
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    await new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(compressed.subarray(payloadOffset, -8))
        controller.close()
      },
    })
      .pipeThrough(new DecompressionStream('deflate-raw'))
      .pipeTo(
        new WritableStream<Uint8Array<ArrayBuffer>>({
          write(chunk) {
            chunks.push(chunk)
            total += chunk.byteLength
            if (total > maxDecodedBytes) throw new Error(INVALID_GZIP)
          },
        }),
      )
  } finally {
    for (const chunk of chunks) chunk.fill(0)
    chunks.length = 0
  }
}

export async function v4GunzipJson(
  compressed: Uint8Array,
  maxDecodedBytes: number,
): Promise<Uint8Array> {
  if (
    !(compressed instanceof Uint8Array) ||
    !Number.isInteger(maxDecodedBytes) ||
    maxDecodedBytes < 1 ||
    maxDecodedBytes > 65_536
  )
    throw new Error(INVALID_GZIP)

  let reader: ReadableStreamDefaultReader<Uint8Array<ArrayBuffer>> | undefined
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    const input = new Uint8Array(compressed)
    await requireSingleMember(input, maxDecodedBytes)
    reader = new ReadableStream<BufferSource>({
      start(controller) {
        controller.enqueue(input)
        controller.close()
      },
    })
      .pipeThrough(new DecompressionStream('gzip'))
      .getReader()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total > maxDecodedBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(INVALID_GZIP)
      }
    }

    const decoded = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      decoded.set(chunk, offset)
      offset += chunk.byteLength
    }
    return decoded
  } catch {
    await reader?.cancel().catch(() => undefined)
    throw new Error(INVALID_GZIP)
  } finally {
    for (const chunk of chunks) chunk.fill(0)
    chunks.length = 0
    try {
      reader?.releaseLock()
    } catch {}
  }
}
