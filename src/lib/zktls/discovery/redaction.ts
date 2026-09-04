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
export function safeClone(
  value: unknown,
  maximumBytes = 512 * 1024,
  maximumNodes = 20_000,
  maximumDepth = 32,
): unknown | null {
  let nodes = 0
  let bytes = 0
  const seen = new Set<object>()
  const validate = (item: unknown, depth: number): boolean => {
    if (++nodes > maximumNodes || depth > maximumDepth) return false
    if (typeof item === 'string') {
      bytes += item.length
      return bytes <= maximumBytes
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
      bytes += key.length
      if (bytes > maximumBytes) return false
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

const normalizedKey = (key: string) =>
  key.replace(/([a-z\d])([A-Z])/g, '$1_$2').toLowerCase()

export const sensitiveKey = (key: string) =>
  /(?:^|[_.-])(?:cookie|authorization|auth|proxy[_.-]?auth|(?:access|refresh|id)[_.-]?token|token|jwt|bearer|api[_.-]?key|access[_.-]?key(?:[_.-]?id)?|password|passwd|secret|signature|private[_.-]?key|mac[_.-]?key|hmac(?:[_.-]?key)?|session(?:[_.-]?id)?|csrf(?:[_.-]?token)?|xsrf(?:[_.-]?token)?|credential)(?:$|[_.-])/.test(
    normalizedKey(key),
  )

const businessIdentifierKey = (key: string) =>
  /(?:^|[_.-])(?:id|wallet|wallet[_.-]?address|account|account[_.-]?id|address|user[_.-]?id|customer[_.-]?id)$/.test(
    normalizedKey(key),
  )
export const dynamicKey = (key: string) =>
  businessIdentifierKey(key) ||
  businessTimeKey(key) ||
  /(?:^|[_.-])(?:id|nonce|cursor|timestamp|time|date|uuid)(?:$|[_.-])|(?:Id|Nonce|Cursor|Timestamp)$/.test(
    key,
  )
export const dynamicValue = (value: string) =>
  /^(?:0x[\da-f]+|[\da-f]{16,}|[\da-f]{8}-[\da-f-]{27,}|\d{8,}|\d{4}-\d\d-\d\dT)/i.test(
    value,
  ) || /^[\w+/=-]{32,}$/.test(value)

function businessTimeKey(key: string): boolean {
  return /(?:^|[_.-])(?:time|timestamp|date)$|_at$|(?:At|Time|Timestamp|Date)$/.test(
    key,
  )
}

function businessTime(value: string, key: string): boolean {
  if (/nonce|cursor|uuid|id$/i.test(key)) return false
  if (businessTimeKey(key) && /^(?:\d{9,10}|\d{12,13})$/.test(value)) {
    const milliseconds = Number(value) * (value.length <= 10 ? 1000 : 1)
    return milliseconds <= 4_102_444_800_000
  }
  const date =
    /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(
      value,
    )?.[1]
  if (!date || !Number.isFinite(Date.parse(value))) return false
  const calendar = new Date(`${date}T00:00:00Z`)
  return (
    Number.isFinite(calendar.getTime()) &&
    calendar.toISOString().slice(0, 10) === date
  )
}

/** Only credential-filtered JSON crosses the store boundary; arbitrary headers never do. */
export function redact(
  value: Json,
  key = '',
  secrets: readonly string[] = [],
): Json {
  if (sensitiveKey(key)) return REDACTED
  if (typeof value === 'number' && secrets.includes(String(value)))
    return REDACTED
  if (
    businessIdentifierKey(key) &&
    value !== null &&
    typeof value !== 'string' &&
    typeof value !== 'number'
  )
    return REDACTED
  if (typeof value === 'string') {
    if (secrets.some((secret) => value.includes(secret))) return REDACTED
    if (/\bBearer\s|lhdao_pk_|[^\s@]+@[^\s@]+\.[^\s@]+/i.test(value))
      return REDACTED
    if (businessIdentifierKey(key))
      return /^\d{4}-\d\d-\d\dT/.test(value) ? REDACTED : value
    if (businessTime(value, key)) return value
    const decimal = /^-?\d+(?:\.\d+)?$/.test(value)
    if ((!decimal || dynamicKey(key)) && dynamicValue(value)) return REDACTED
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

/** Original types, but only paths visible after redaction. Masked parents stop traversal. */
function visibleShape(
  original: Json,
  redacted: Json,
  prefix: string,
): Record<string, string> {
  const types = new Map<string, Set<string>>()
  const visit = (raw: Json, safe: Json, path: string) => {
    const values = types.get(path) ?? new Set<string>()
    values.add(
      raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw,
    )
    types.set(path, values)
    if (Array.isArray(safe)) {
      safe.forEach((item, index) => {
        visit(Array.isArray(raw) ? raw[index] : item, item, `${path}[]`)
      })
    } else if (safe && typeof safe === 'object') {
      for (const [key, item] of Object.entries(safe)) {
        const child =
          raw &&
          typeof raw === 'object' &&
          !Array.isArray(raw) &&
          Object.hasOwn(raw, key)
            ? raw[key]
            : item
        visit(child, item, `${path}.${key}`)
      }
    }
  }
  visit(original, redacted, prefix)
  return Object.fromEntries(
    [...types]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, values]) => [path, [...values].sort().join('|')]),
  )
}

export function jsonBody(
  text: unknown,
  secrets: readonly string[] = [],
  prefix = '',
): {
  state: BodyState
  value: Json | null
  bytes: number
  shape?: Record<string, string>
} {
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
    return {
      state: 'json',
      value,
      bytes,
      shape: visibleShape(cloned as Json, value, prefix),
    }
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
  for (const headers of [raw.requestHeaders, raw.responseHeaders]) {
    if (!headers || typeof headers !== 'object') continue
    for (const [name, text] of Object.entries(headers)) {
      if (typeof text !== 'string') continue
      if (/^(?:proxy-)?authorization$/i.test(name)) {
        const credential = /^\S+\s+(.+)$/.exec(text)?.[1]?.trim()
        if (credential) found.add(credential)
        if (/^Basic\s/i.test(text) && credential) {
          try {
            const decoded = atob(credential)
            found.add(decoded)
            for (const part of decoded.split(':')) if (part) found.add(part)
          } catch {
            /* malformed Basic */
          }
        }
        for (const match of text.matchAll(
          /(?:^|[,\s])[\w-]+=(?:"([^"]+)"|([^,\s]+))/g,
        ))
          found.add(match[1] ?? match[2])
      }
      if (/^(?:set-)?cookie$/i.test(name)) {
        const pairs = /^set-/i.test(name)
          ? text.split(';').slice(0, 1)
          : text.split(';')
        for (const pair of pairs) {
          const value = pair
            .slice(pair.indexOf('=') + 1)
            .trim()
            .replace(/^"(.*)"$/, '$1')
          if (pair.includes('=') && value) found.add(value)
        }
      }
    }
  }
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
