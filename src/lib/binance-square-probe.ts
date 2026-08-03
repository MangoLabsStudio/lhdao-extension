export type BinanceProbeTarget = {
  kind: 'CONTENT' | 'AUTHOR'
  id: string
}

export interface BinanceProbeObservation {
  id: string
  method: 'POST'
  path: string
  status: number
  target: BinanceProbeTarget
  requestShape: unknown
  responseShape: unknown
  capturedAt: string
}

const MAX_DEPTH = 6
const MAX_KEYS = 80
const MAX_ARRAY_ITEMS = 5
const MAX_JSON_LENGTH = 16_384
const MAX_NODES = 500
const SENSITIVE_KEY_RE =
  /authorization|cookie|csrf|secret|session|token|credential|password/i
const SAFE_MARKER_RE =
  /^<(?:target:(?:CONTENT|AUTHOR)|digits:\d+|string:\d+|number|max-depth|max-nodes|circular|unsupported)>$/u
const TARGET_ID_RE = /^\d{6,32}$/u
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const OBSERVATION_KEYS = [
  'capturedAt',
  'id',
  'method',
  'path',
  'requestShape',
  'responseShape',
  'status',
  'target',
]

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return prototype === Object.prototype || prototype === null
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  return (
    actual.length === keys.length && actual.every((key, i) => key === keys[i])
  )
}

function targetForScalar(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): BinanceProbeTarget | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const scalar = String(value)
  for (const candidate of targets) {
    const target = record(candidate)
    if (
      (target?.kind === 'CONTENT' || target?.kind === 'AUTHOR') &&
      typeof target.id === 'string' &&
      TARGET_ID_RE.test(target.id) &&
      target.id === scalar
    ) {
      return { kind: target.kind, id: target.id }
    }
  }
  return null
}

export function findProbeTarget(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): BinanceProbeTarget | null {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }]
  let visited = 0
  while (stack.length > 0 && visited < MAX_NODES) {
    const current = stack.pop()!
    visited += 1
    const matched = targetForScalar(current.value, targets)
    if (matched) return matched
    if (current.depth >= MAX_DEPTH || !current.value) continue
    if (Array.isArray(current.value)) {
      for (const item of current.value.slice(0, MAX_ARRAY_ITEMS)) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    const obj = record(current.value)
    if (!obj) continue
    for (const key of Object.keys(obj).sort().slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY_RE.test(key)) continue
      stack.push({ value: obj[key], depth: current.depth + 1 })
    }
  }
  return null
}

function sanitize(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
  depth: number,
  state: { nodes: number; seen: WeakSet<object> },
): unknown {
  state.nodes += 1
  if (state.nodes > MAX_NODES) return '<max-nodes>'
  if (depth > MAX_DEPTH) return '<max-depth>'
  if (value === null || typeof value === 'boolean') return value
  const matched = targetForScalar(value, targets)
  if (matched) return `<target:${matched.kind}>`
  if (typeof value === 'string') {
    return /^\d+$/u.test(value)
      ? `<digits:${value.length}>`
      : `<string:${value.length}>`
  }
  if (typeof value === 'number') return '<number>'
  if (!value || typeof value !== 'object') return '<unsupported>'
  if (state.seen.has(value)) return '<circular>'
  state.seen.add(value)
  if (Array.isArray(value)) {
    return Array.from(value.slice(0, MAX_ARRAY_ITEMS), (item) =>
      sanitize(item, targets, depth + 1, state),
    )
  }
  const obj = record(value)
  if (!obj) return '<unsupported>'
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort().slice(0, MAX_KEYS)) {
    if (SENSITIVE_KEY_RE.test(key)) continue
    out[key] = sanitize(obj[key], targets, depth + 1, state)
  }
  return out
}

export function sanitizeProbeValue(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): unknown {
  const result = sanitize(value, targets, 0, {
    nodes: 0,
    seen: new WeakSet(),
  })
  return serializedShapeFits(result) && isSanitizedShape(result)
    ? result
    : { truncated: true }
}

function probePath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (
      url.origin !== 'https://www.binance.com' ||
      !url.pathname.startsWith('/bapi/')
    ) {
      return null
    }
    const parts: string[] = []
    for (const part of url.pathname.split('/')) {
      const decoded = decodeURIComponent(part)
      parts.push(
        /^\d{6,}$/u.test(decoded) || /^[A-Za-z0-9_-]{24,}$/u.test(decoded)
          ? ':id'
          : part,
      )
    }
    const path = parts.join('/')
    return path.length <= 512 ? path : null
  } catch {
    return null
  }
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    return new Date(value).toISOString() === value
  } catch {
    return false
  }
}

export function buildProbeObservation(args: {
  url: string
  method: string
  status: number
  request: unknown
  response: unknown
  targets: readonly BinanceProbeTarget[]
  capturedAt: string
}): BinanceProbeObservation | null {
  const path = probePath(args.url)
  const target = findProbeTarget(args.request, args.targets)
  if (
    args.method.toUpperCase() !== 'POST' ||
    !path ||
    !target ||
    !isCanonicalIsoTimestamp(args.capturedAt) ||
    !Number.isInteger(args.status) ||
    args.status < 0 ||
    args.status > 599
  ) {
    return null
  }
  return {
    id: crypto.randomUUID(),
    method: 'POST',
    path,
    status: args.status,
    target,
    requestShape: sanitizeProbeValue(args.request, args.targets),
    responseShape: sanitizeProbeValue(args.response, args.targets),
    capturedAt: args.capturedAt,
  }
}

function isSanitizedShape(
  value: unknown,
  depth = 0,
  state = { nodes: 0 },
): boolean {
  state.nodes += 1
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH + 1) return false
  if (value === null || typeof value === 'boolean') return true
  if (typeof value === 'string') return SAFE_MARKER_RE.test(value)
  if (typeof value === 'number' || typeof value === 'undefined') return false
  if (Array.isArray(value)) {
    const keys = Object.keys(value)
    return (
      value.length <= MAX_ARRAY_ITEMS &&
      keys.length === value.length &&
      keys.every((key, index) => key === String(index)) &&
      value.every((item) => isSanitizedShape(item, depth + 1, state))
    )
  }
  const obj = record(value)
  if (!obj || Object.keys(obj).length > MAX_KEYS) return false
  return Object.entries(obj).every(
    ([key, item]) =>
      key.length <= 128 &&
      !SENSITIVE_KEY_RE.test(key) &&
      isSanitizedShape(item, depth + 1, state),
  )
}

function serializedShapeFits(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= MAX_JSON_LENGTH
  } catch {
    return false
  }
}

export function parseProbeObservation(
  value: unknown,
): BinanceProbeObservation | null {
  const obj = record(value)
  const target = record(obj?.target)
  if (
    !obj ||
    !hasOnlyKeys(obj, OBSERVATION_KEYS) ||
    typeof obj.id !== 'string' ||
    !UUID_V4_RE.test(obj.id) ||
    obj.method !== 'POST' ||
    typeof obj.path !== 'string' ||
    probePath(`https://www.binance.com${obj.path}`) !== obj.path ||
    !Number.isInteger(obj.status) ||
    Number(obj.status) < 0 ||
    Number(obj.status) > 599 ||
    !target ||
    !hasOnlyKeys(target, ['id', 'kind']) ||
    (target.kind !== 'CONTENT' && target.kind !== 'AUTHOR') ||
    typeof target.id !== 'string' ||
    !TARGET_ID_RE.test(target.id) ||
    !isCanonicalIsoTimestamp(obj.capturedAt) ||
    !isSanitizedShape(obj.requestShape) ||
    !isSanitizedShape(obj.responseShape) ||
    !serializedShapeFits(obj.requestShape) ||
    !serializedShapeFits(obj.responseShape)
  ) {
    return null
  }
  return obj as unknown as BinanceProbeObservation
}

export function parseProbeObservationMessage(
  value: unknown,
): BinanceProbeObservation | null {
  const obj = record(value)
  return obj &&
    hasOnlyKeys(obj, ['__lhBinanceProbe', 'observation']) &&
    obj.__lhBinanceProbe === true
    ? parseProbeObservation(obj.observation)
    : null
}
