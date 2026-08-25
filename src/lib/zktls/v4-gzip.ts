const INVALID_GZIP = 'V4 gzip response is invalid.'

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
      total += value.byteLength
      if (total > maxDecodedBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(INVALID_GZIP)
      }
      chunks.push(value)
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
    chunks.length = 0
    try {
      reader?.releaseLock()
    } catch {}
  }
}
