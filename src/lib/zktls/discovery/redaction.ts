export const BODY_LIMIT = 64 * 1024
export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json }
export const REDACTED = '[REDACTED]'
const encoder = new TextEncoder()
export const byteLength = (text: string) => encoder.encode(text).byteLength

/** Descriptors first (no getter execution), clone second (reject proxies). */
export function safeClone(value: unknown): unknown | null {
  let nodes = 0
  let bytes = 0
  const seen = new Set<object>()
  const validate = (item: unknown, depth: number): boolean => {
    if (++nodes > 20_000 || depth > 32) return false
    if (typeof item === 'string') {
      bytes += item.length
      return bytes <= 512 * 1024
    }
    if (item === null || item === undefined || typeof item === 'boolean')
      return true
    if (typeof item === 'number') return Number.isFinite(item)
    if (typeof item !== 'object' || seen.has(item)) return false
    seen.add(item)
    const proto = Object.getPrototypeOf(item)
    if (
      Array.isArray(item)
        ? proto !== Array.prototype
        : proto !== Object.prototype && proto !== null
    )
      return false
    for (const key of Reflect.ownKeys(item)) {
      if (typeof key !== 'string') return false
      if (Array.isArray(item) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (
        !descriptor?.enumerable ||
        !('value' in descriptor) ||
        !validate(descriptor.value, depth + 1)
      )
        return false
    }
    seen.delete(item)
    return true
  }
  try {
    return validate(value, 0) ? structuredClone(value) : null
  } catch {
    return null
  }
}

export const sensitiveKey = (key: string) =>
  /(?:^|[_-])id$/i.test(key) ||
  /cookie|authorization|auth|proxy.?auth|token|api.?key|password|passwd|secret|signature|private.?key|mac.?key|hmac|wallet|account|address|email|phone|profile|username|user.?id|customer.?id|session|csrf|xsrf|credential/i.test(
    key,
  )
export const dynamicKey = (key: string) =>
  /(?:^|[_.-])(?:id|nonce|cursor|timestamp|time|date|uuid)(?:$|[_.-])|(?:Id|Nonce|Cursor|Timestamp)$/.test(
    key,
  )
export const dynamicValue = (value: string) =>
  /^(?:0x[\da-f]+|[\da-f]{16,}|[\da-f]{8}-[\da-f-]{27,}|\d{8,}|\d{4}-\d\d-\d\dT)/i.test(
    value,
  ) || /^[\w+/=-]{32,}$/.test(value)

/** Only redacted JSON crosses the store boundary; arbitrary headers never do. */
export function redact(
  value: Json,
  key = '',
  secrets: readonly string[] = [],
): Json {
  if (sensitiveKey(key)) return REDACTED
  if (typeof value === 'number' && secrets.includes(String(value)))
    return REDACTED
  if (typeof value === 'string') {
    if (secrets.some((secret) => value.includes(secret))) return REDACTED
    const decimal = /^-?\d+(?:\.\d+)?$/.test(value)
    if (
      ((!decimal || dynamicKey(key)) && dynamicValue(value)) ||
      /\bBearer\s|lhdao_pk_|[^\s@]+@[^\s@]+\.[^\s@]+/i.test(value)
    )
      return REDACTED
    if (/^https?:\/\//i.test(value))
      return redactUrl(value, secrets)?.url ?? REDACTED
    return value
  }
  if (Array.isArray(value))
    return value.map((item) => redact(item, key, secrets))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [
        dynamicValue(name) || secrets.some((secret) => name.includes(secret))
          ? REDACTED
          : name,
        redact(item, name, secrets),
      ]),
    )
  return value
}

export function redactUrl(raw: string, secrets: readonly string[] = []) {
  try {
    if (raw.length > 4096) return null
    const parsed = new URL(raw)
    if (!['https:', 'http:'].includes(parsed.protocol)) return null
    const parts = parsed.pathname.split('/')
    const path = parts
      .map((part, index) => {
        let decoded: string
        try {
          decoded = decodeURIComponent(part)
        } catch {
          return REDACTED
        }
        return dynamicValue(decoded) ||
          sensitiveKey(parts[index - 1] ?? '') ||
          /^\d+$/.test(decoded) ||
          secrets.some((secret) => decoded.includes(secret))
          ? REDACTED
          : part
      })
      .join('/')
    const query: Record<string, Json> = Object.create(null)
    for (const [key, value] of [...parsed.searchParams.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      const name =
        dynamicValue(key) || secrets.some((secret) => key.includes(secret))
          ? REDACTED
          : key
      const redacted = redact(value, key, secrets)
      const previous = query[name]
      query[name] =
        previous === undefined
          ? redacted
          : Array.isArray(previous)
            ? [...previous, redacted]
            : [previous, redacted]
    }
    // Credentials and fragments are deliberately not reconstructed.
    const search = new URLSearchParams(
      Object.entries(query).flatMap(([key, value]) =>
        (Array.isArray(value) ? value : [value]).map((item) => [
          key,
          String(item),
        ]),
      ),
    )
    return {
      origin: parsed.origin,
      path,
      query,
      url: `${parsed.origin}${path}${search.size ? `?${search}` : ''}`,
    }
  } catch {
    return null
  }
}

export type BodyState =
  | 'json'
  | 'empty'
  | 'non-json'
  | 'oversize'
  | 'unavailable'
  | 'invalid'
export function jsonBody(
  text: unknown,
  secrets: readonly string[] = [],
): { state: BodyState; value: Json | null; bytes: number } {
  const bytes =
    typeof text === 'string' ? Math.min(BODY_LIMIT + 1, byteLength(text)) : 0
  if (text === undefined) return { state: 'unavailable', value: null, bytes }
  if (typeof text !== 'string') return { state: 'invalid', value: null, bytes }
  if (text.length > BODY_LIMIT || bytes > BODY_LIMIT)
    return { state: 'oversize', value: null, bytes }
  if (!text.trim()) return { state: 'empty', value: null, bytes }
  try {
    const parsed: unknown = JSON.parse(text)
    const cloned = safeClone(parsed)
    if (cloned === null && parsed !== null)
      return { state: 'invalid', value: null, bytes }
    const value = redact(cloned as Json, '', secrets)
    if (byteLength(JSON.stringify(value)) > BODY_LIMIT)
      return { state: 'oversize', value: null, bytes }
    return { state: 'json', value, bytes }
  } catch {
    return { state: 'non-json', value: null, bytes }
  }
}

const reservedHeaders = new Set([
  'accept-encoding',
  'accept-language',
  'cache-control',
  'connection',
  'dnt',
  'host',
  'origin',
  'pragma',
  'priority',
  'referer',
  'upgrade-insecure-requests',
  'user-agent',
])
export function publicHeaders(
  value: unknown,
  response = false,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, string> = {}
  for (const [rawName, text] of Object.entries(value).sort(([a], [b]) =>
    a.toLowerCase().localeCompare(b.toLowerCase()),
  )) {
    const name = rawName.toLowerCase()
    if (
      typeof text !== 'string' ||
      name.length > 64 ||
      !/^[a-z][a-z0-9-]*$/.test(name) ||
      text.length > 256 ||
      !/^[\x20-\x7e]+$/.test(text) ||
      text.trim() !== text
    )
      continue
    if (
      sensitiveKey(name) ||
      name.startsWith('sec-') ||
      reservedHeaders.has(name) ||
      dynamicValue(text)
    )
      continue
    if (
      response &&
      ![
        'content-type',
        'content-encoding',
        'content-length',
        'transfer-encoding',
      ].includes(name)
    )
      continue
    if (
      name === 'content-type' &&
      !/^(?:application\/(?:[\w.+-]+)|text\/plain)(?:;\s*charset=[\w-]+)?$/i.test(
        text,
      )
    )
      continue
    if (
      name === 'content-encoding' &&
      !/^(?:gzip|br|deflate|identity)$/i.test(text)
    )
      continue
    if (name === 'transfer-encoding' && text !== 'chunked') continue
    if (name === 'content-length' && !/^\d{1,12}$/.test(text)) continue
    if (redact(text) !== text) continue
    if (Object.keys(result).length < 12) result[name] = text
  }
  return result
}

/** Propagate known sensitive values into echoes without retaining a secret index. */
export function observationSecrets(raw: Record<string, unknown>): string[] {
  const found = new Set<string>()
  const visit = (value: unknown, key = '') => {
    if (
      sensitiveKey(key) &&
      (typeof value === 'string' || typeof value === 'number')
    ) {
      if (String(value).length) found.add(String(value))
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value))
        visit(item, sensitiveKey(key) ? key : name)
    }
  }
  visit(raw.requestHeaders)
  visit(raw.responseHeaders)
  for (const body of [raw.requestBody, raw.responseBody]) {
    if (typeof body !== 'string' || byteLength(body) > BODY_LIMIT) continue
    try {
      const value: unknown = JSON.parse(body)
      if (safeClone(value) !== null) visit(value)
    } catch {
      /* non JSON */
    }
  }
  for (const rawUrl of [raw.url, raw.documentUrl]) {
    if (typeof rawUrl !== 'string') continue
    try {
      const url = new URL(rawUrl)
      if (url.username) found.add(decodeURIComponent(url.username))
      if (url.password) found.add(decodeURIComponent(url.password))
      for (const [key, value] of url.searchParams) visit(value, key)
      const path = url.pathname.split('/').map(decodeURIComponent)
      path.forEach((value, index) => {
        visit(value, path[index - 1] ?? '')
      })
    } catch {
      /* invalid URL */
    }
  }
  return [...found]
}

export function freezeCopy<T>(value: T): T {
  const clone: T = structuredClone(value)
  const freeze = (item: unknown) => {
    if (!item || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(clone)
  return clone
}
