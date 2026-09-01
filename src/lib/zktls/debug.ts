const SENSITIVE_KEY =
  /^(?:cookie|set-cookie|authorization|proxy-authorization|mac[-_]?key|.*token.*|.*secret.*)$/i
const encoder = new TextEncoder()
const fatalDecoder = new TextDecoder('utf-8', { fatal: true })
const textDecoder = new TextDecoder()

type DebugWriter = (...values: unknown[]) => void

function sensitiveSummary(value: unknown): {
  present: boolean
  length: number
} {
  if (typeof value === 'string')
    return { present: value.length > 0, length: value.length }
  if (value instanceof Uint8Array)
    return { present: value.byteLength > 0, length: value.byteLength }
  if (Array.isArray(value))
    return { present: value.length > 0, length: value.length }
  if (value && typeof value === 'object') {
    const length = Object.keys(Object.getOwnPropertyDescriptors(value)).length
    return { present: length > 0, length }
  }
  return { present: value !== null && value !== undefined, length: 0 }
}

function sanitize(
  value: unknown,
  seen: WeakSet<object>,
  secretValues: readonly string[],
): unknown {
  if (typeof value === 'string') return redactText(value, secretValues)
  if (
    value === null ||
    value === undefined ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
    return value
  if (typeof value !== 'object') return String(value)
  if (seen.has(value)) return '[circular]'
  seen.add(value)

  if (value instanceof Error)
    return {
      name: value.name,
      message: redactText(value.message, secretValues),
      stack: redactText(value.stack ?? '', secretValues),
    }
  if (value instanceof Uint8Array)
    return { byteLength: value.byteLength, base64: bytesToBase64(value) }
  if (Array.isArray(value))
    return value.map((item) => sanitize(item, seen, secretValues))

  const output: Record<string, unknown> = {}
  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (!descriptor.enumerable) continue
    if (!('value' in descriptor)) {
      output[key] = '[accessor]'
      continue
    }
    output[key] = SENSITIVE_KEY.test(key)
      ? sensitiveSummary(descriptor.value)
      : sanitize(descriptor.value, seen, secretValues)
  }
  return output
}

function redactText(value: string, secrets: readonly string[]): string {
  let redacted = value
  for (const secret of secrets) {
    if (secret.length > 0) redacted = redacted.replaceAll(secret, '[REDACTED]')
  }
  return redacted
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function headerBoundary(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.length - 4; index += 1) {
    if (
      bytes[index] === 13 &&
      bytes[index + 1] === 10 &&
      bytes[index + 2] === 13 &&
      bytes[index + 3] === 10
    )
      return index
  }
  return -1
}

export function sanitizeZkTlsDebugValue(value: unknown): unknown {
  return sanitize(value, new WeakSet(), [])
}

export function redactZkTlsHttpTranscript(bytes: Uint8Array): string {
  const boundary = headerBoundary(bytes)
  if (boundary < 0) return `[body base64]${bytesToBase64(bytes)}`
  const headers = textDecoder
    .decode(bytes.subarray(0, boundary))
    .split('\r\n')
    .map((line) => {
      const colon = line.indexOf(':')
      if (colon <= 0 || !SENSITIVE_KEY.test(line.slice(0, colon))) return line
      const value = line.slice(colon + 1).trim()
      return `${line.slice(0, colon)}: [redacted length=${value.length}]`
    })
    .join('\r\n')
  const body = bytes.subarray(boundary + 4)
  try {
    const text = fatalDecoder.decode(body)
    if (encoder.encode(text).length === body.length)
      return `${headers}\r\n\r\n${text}`
  } catch {
    // Binary proof bodies remain complete as base64.
  }
  return `${headers}\r\n\r\n[body base64]${bytesToBase64(body)}`
}

export function createZkTlsDebugTrace(input: {
  enabled: boolean
  correlationId: string
  write?: DebugWriter
}): {
  stage(name: string, details?: unknown): void
  fail(name: string, error: unknown, secretValues?: readonly string[]): void
} {
  const write = input.write ?? console.debug
  let sequence = 0
  const emit = (payload: unknown): void => {
    if (!input.enabled) return
    try {
      write('[Lighthouse zkTLS debug]', payload)
    } catch {
      // Diagnostics never affect proof execution.
    }
  }
  return {
    stage(name, details) {
      sequence += 1
      emit({
        sequence,
        correlationId: input.correlationId,
        stage: name,
        details: sanitize(details, new WeakSet(), []),
      })
    },
    fail(name, error, secretValues = []) {
      sequence += 1
      emit({
        sequence,
        correlationId: input.correlationId,
        stage: name,
        error: sanitize(error, new WeakSet(), secretValues),
      })
    },
  }
}
