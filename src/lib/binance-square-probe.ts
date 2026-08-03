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
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
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
  return targets.find((target) => target.id === scalar) ?? null
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
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => sanitize(item, targets, depth + 1, state))
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort().slice(0, MAX_KEYS)) {
    if (SENSITIVE_KEY_RE.test(key)) continue
    out[key] = sanitize(
      (value as Record<string, unknown>)[key],
      targets,
      depth + 1,
      state,
    )
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
  return JSON.stringify(result).length <= MAX_JSON_LENGTH
    ? result
    : { truncated: true }
}

function probePath(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl)
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'www.binance.com' ||
      !url.pathname.startsWith('/bapi/')
    ) {
      return null
    }
    return url.pathname
      .split('/')
      .map((part) =>
        /^\d{6,}$/u.test(part) || /^[A-Za-z0-9_-]{24,}$/u.test(part)
          ? ':id'
          : part,
      )
      .join('/')
      .slice(0, 512)
  } catch {
    return null
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
    return (
      value.length <= MAX_ARRAY_ITEMS &&
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
    obj.id.length > 128 ||
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
    !/^\d{6,32}$/u.test(target.id) ||
    typeof obj.capturedAt !== 'string' ||
    !Number.isFinite(Date.parse(obj.capturedAt)) ||
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
