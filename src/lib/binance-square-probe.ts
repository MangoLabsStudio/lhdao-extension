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
const MAX_TARGETS = 500
const OBSERVATION_ENVELOPE_OVERHEAD = '{"__lhBinanceProbe":true,"observation":}'
  .length
const SENSITIVE_KEY_RE =
  /authorization|cookie|csrf|secret|session|token|credential|password/i
const SAFE_MARKER_RE =
  /^<(?:target:(?:CONTENT|AUTHOR)|digits:\d+|string:\d+|number|max-depth|max-nodes|circular|unsupported)>$/u
const SAFE_KEY_MARKER_RE =
  /^<key:(?:digits|string):(?:0|[1-9]\d*):(?:[0-9]|[1-7][0-9])>$/u
const TARGET_ID_RE = /^\d{6,32}$/u
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SAFE_SHAPE_KEYS = new Set([
  'postId',
  'authorId',
  'userId',
  'uid',
  'id',
  'text',
  'ok',
  'nested',
  'code',
  'data',
  'result',
  'value',
  'deep',
  'truncated',
  'count',
  'empty',
  'array',
  'bounds',
])
const SAFE_PATH_SEGMENTS = new Set([
  'v1',
  'v2',
  'v3',
  'public',
  'private',
  'square',
  'post',
  'posts',
  'article',
  'content',
  'comment',
  'comments',
  'like',
  'follow',
  'share',
  'user',
  'profile',
  'detail',
  'list',
  'query',
  'search',
  'create',
  'update',
  'delete',
  'status',
  'example',
])
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

function boundedOwnEnumerableKeys(
  value: object,
  limit: number,
): { keys: string[]; overflow: boolean } {
  const keys: string[] = []
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue
    keys.push(key)
    if (keys.length > limit) return { keys, overflow: true }
  }
  return { keys, overflow: false }
}

function boundedOwnEnumerableData(
  value: object,
  limit: number,
): { keys: string[]; overflow: boolean; values: Map<string, unknown> } | null {
  try {
    const collected = boundedOwnEnumerableKeys(value, limit)
    const values = new Map<string, unknown>()
    for (const key of collected.keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !('value' in descriptor)) return null
      values.set(key, descriptor.value)
    }
    return { ...collected, values }
  } catch {
    return null
  }
}

function exactOwnEnumerableData(
  value: object,
  keys: string[],
): Map<string, unknown> | null {
  const collected = boundedOwnEnumerableData(value, keys.length)
  if (!collected || collected.overflow) return null
  const actual = collected.keys.sort()
  return actual.length === keys.length &&
    actual.every((key, index) => key === keys[index])
    ? collected.values
    : null
}

function ownArrayLength(value: unknown[]): number | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length')
    return descriptor &&
      'value' in descriptor &&
      Number.isSafeInteger(descriptor.value) &&
      descriptor.value >= 0
      ? descriptor.value
      : null
  } catch {
    return null
  }
}

function ownArrayPrefix(value: unknown[], limit: number): unknown[] | null {
  const length = ownArrayLength(value)
  if (length === null) return null
  const items: unknown[] = []
  try {
    for (let index = 0; index < Math.min(length, limit); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor) {
        items.push(undefined)
        continue
      }
      if (!descriptor.enumerable || !('value' in descriptor)) return null
      items.push(descriptor.value)
    }
    return items
  } catch {
    return null
  }
}

function hasToJsonInPrototypeChain(value: object): boolean {
  try {
    const seen = new Set<object>()
    let current: object | null = value
    for (let depth = 0; current && depth < 8; depth += 1) {
      if (seen.has(current)) return true
      seen.add(current)
      if (Object.getOwnPropertyDescriptor(current, 'toJSON')) return true
      current = Object.getPrototypeOf(current)
    }
    return current !== null
  } catch {
    return true
  }
}

function sanitizedKey(key: string, ordinal: number): string {
  if (SAFE_SHAPE_KEYS.has(key)) return key
  const kind = /^\d+$/u.test(key) ? 'digits' : 'string'
  return `<key:${kind}:${key.length}:${ordinal}>`
}

function targetForScalar(
  value: unknown,
  targets: readonly BinanceProbeTarget[],
): BinanceProbeTarget | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  if (
    typeof value === 'number' &&
    (!Number.isSafeInteger(value) || value < 0)
  ) {
    return null
  }
  const scalar = String(value)
  for (const candidate of targets) {
    const target = record(candidate)
    const data = target && boundedOwnEnumerableData(target, MAX_KEYS)
    const kind = data?.values.get('kind')
    const id = data?.values.get('id')
    if (
      (kind === 'CONTENT' || kind === 'AUTHOR') &&
      typeof id === 'string' &&
      TARGET_ID_RE.test(id) &&
      id === scalar
    ) {
      return { kind, id }
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
      const items = ownArrayPrefix(current.value, MAX_ARRAY_ITEMS)
      if (!items) continue
      for (const item of items) {
        stack.push({ value: item, depth: current.depth + 1 })
      }
      continue
    }
    const obj = record(current.value)
    if (!obj) continue
    const collected = boundedOwnEnumerableData(obj, MAX_KEYS)
    if (!collected) continue
    for (const key of collected.keys.slice(0, MAX_KEYS).sort()) {
      if (SENSITIVE_KEY_RE.test(key)) continue
      stack.push({
        value: collected.values.get(key),
        depth: current.depth + 1,
      })
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
    const items = ownArrayPrefix(value, MAX_ARRAY_ITEMS)
    if (!items) return '<unsupported>'
    return items.map((item) => sanitize(item, targets, depth + 1, state))
  }
  const obj = record(value)
  if (!obj) return '<unsupported>'
  const out: Record<string, unknown> = {}
  const collected = boundedOwnEnumerableData(obj, MAX_KEYS)
  if (!collected) return '<unsupported>'
  let ordinal = 0
  for (const key of collected.keys.slice(0, MAX_KEYS).sort()) {
    if (SENSITIVE_KEY_RE.test(key)) continue
    out[sanitizedKey(key, ordinal)] = sanitize(
      collected.values.get(key),
      targets,
      depth + 1,
      state,
    )
    ordinal += 1
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
  return isSanitizedShape(result) && serializedShapeFits(result)
    ? result
    : Object.assign(Object.create(null), { truncated: true })
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
    for (const [index, part] of url.pathname.split('/').entries()) {
      const decoded = decodeURIComponent(part)
      if (index === 0) {
        parts.push('')
        continue
      }
      if (index === 1) {
        if (decoded !== 'bapi') return null
        parts.push(decoded)
        continue
      }
      const structural = decoded.toLowerCase()
      parts.push(
        /^\d{6,}$/u.test(decoded) || /^[A-Za-z0-9_-]{24,}$/u.test(decoded)
          ? ':id'
          : decoded === ':id' || decoded === ':segment'
            ? decoded
            : SAFE_PATH_SEGMENTS.has(structural)
              ? structural
              : ':segment',
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
    if (hasToJsonInPrototypeChain(value)) return false
    const length = ownArrayLength(value)
    if (length === null || length > MAX_ARRAY_ITEMS) return false
    const collected = boundedOwnEnumerableData(value, length)
    return (
      !!collected &&
      !collected.overflow &&
      collected.keys.length === length &&
      collected.keys.every((key, index) => key === String(index)) &&
      collected.keys.every((key) =>
        isSanitizedShape(collected.values.get(key), depth + 1, state),
      )
    )
  }
  const obj = record(value)
  if (!obj || hasToJsonInPrototypeChain(obj)) return false
  const collected = boundedOwnEnumerableData(obj, MAX_KEYS)
  if (!collected || collected.overflow) return false
  return collected.keys.every(
    (key) =>
      key.length <= 128 &&
      !SENSITIVE_KEY_RE.test(key) &&
      (SAFE_SHAPE_KEYS.has(key) || SAFE_KEY_MARKER_RE.test(key)) &&
      isSanitizedShape(collected.values.get(key), depth + 1, state),
  )
}

function serializedShapeFits(value: unknown): boolean {
  const length = serializedLength(value)
  return length !== null && length <= MAX_JSON_LENGTH
}

function serializedLength(value: unknown): number | null {
  try {
    return JSON.stringify(value).length
  } catch {
    return null
  }
}

function parseProbeObservationWithLength(
  value: unknown,
): { observation: BinanceProbeObservation; serializedLength: number } | null {
  const obj = record(value)
  const data = obj && exactOwnEnumerableData(obj, OBSERVATION_KEYS)
  const target = record(data?.get('target'))
  const targetData = target && exactOwnEnumerableData(target, ['id', 'kind'])
  const id = data?.get('id')
  const method = data?.get('method')
  const path = data?.get('path')
  const status = data?.get('status')
  const targetId = targetData?.get('id')
  const targetKind = targetData?.get('kind')
  const capturedAt = data?.get('capturedAt')
  const requestShape = data?.get('requestShape')
  const responseShape = data?.get('responseShape')
  if (
    !obj ||
    hasToJsonInPrototypeChain(obj) ||
    !data ||
    typeof id !== 'string' ||
    !UUID_V4_RE.test(id) ||
    method !== 'POST' ||
    typeof path !== 'string' ||
    probePath(`https://www.binance.com${path}`) !== path ||
    !Number.isInteger(status) ||
    Number(status) < 0 ||
    Number(status) > 599 ||
    !target ||
    hasToJsonInPrototypeChain(target) ||
    !targetData ||
    (targetKind !== 'CONTENT' && targetKind !== 'AUTHOR') ||
    typeof targetId !== 'string' ||
    !TARGET_ID_RE.test(targetId) ||
    !isCanonicalIsoTimestamp(capturedAt) ||
    !isSanitizedShape(requestShape) ||
    !isSanitizedShape(responseShape) ||
    !serializedShapeFits(requestShape) ||
    !serializedShapeFits(responseShape)
  ) {
    return null
  }
  const length = serializedLength(obj)
  return length !== null && length <= MAX_JSON_LENGTH
    ? {
        observation: obj as unknown as BinanceProbeObservation,
        serializedLength: length,
      }
    : null
}

export function parseProbeObservation(
  value: unknown,
): BinanceProbeObservation | null {
  return parseProbeObservationWithLength(value)?.observation ?? null
}

export function parseProbeObservationMessage(
  value: unknown,
): BinanceProbeObservation | null {
  try {
    const obj = record(value)
    const data =
      obj && exactOwnEnumerableData(obj, ['__lhBinanceProbe', 'observation'])
    if (
      !obj ||
      hasToJsonInPrototypeChain(obj) ||
      !data ||
      data.get('__lhBinanceProbe') !== true
    ) {
      return null
    }
    const parsed = parseProbeObservationWithLength(data.get('observation'))
    return parsed &&
      parsed.serializedLength + OBSERVATION_ENVELOPE_OVERHEAD <= MAX_JSON_LENGTH
      ? parsed.observation
      : null
  } catch {
    return null
  }
}

export function parseProbeTargetConfigMessage(
  value: unknown,
): BinanceProbeTarget[] | null {
  try {
    const obj = record(value)
    const data =
      obj && exactOwnEnumerableData(obj, ['__lhBinanceProbeConfig', 'targets'])
    const targetList = data?.get('targets')
    const targetListArray = Array.isArray(targetList) ? targetList : null
    const targetListLength = targetListArray
      ? ownArrayLength(targetListArray)
      : null
    if (
      !obj ||
      hasToJsonInPrototypeChain(obj) ||
      !data ||
      data.get('__lhBinanceProbeConfig') !== true ||
      !targetListArray ||
      hasToJsonInPrototypeChain(targetListArray) ||
      targetListLength === null ||
      targetListLength > MAX_TARGETS
    ) {
      return null
    }
    const entries = boundedOwnEnumerableData(targetListArray, targetListLength)
    if (
      !entries ||
      entries.overflow ||
      entries.keys.length !== targetListLength ||
      !entries.keys.every((key, index) => key === String(index))
    ) {
      return null
    }
    const targets: BinanceProbeTarget[] = []
    const seen = new Set<string>()
    for (const entryKey of entries.keys) {
      const target = record(entries.values.get(entryKey))
      const targetData =
        target && exactOwnEnumerableData(target, ['id', 'kind'])
      const kind = targetData?.get('kind')
      const id = targetData?.get('id')
      if (
        !target ||
        hasToJsonInPrototypeChain(target) ||
        !targetData ||
        (kind !== 'CONTENT' && kind !== 'AUTHOR') ||
        typeof id !== 'string' ||
        !TARGET_ID_RE.test(id)
      ) {
        return null
      }
      const key = `${kind}:${id}`
      if (seen.has(key)) continue
      seen.add(key)
      targets.push({ kind, id })
    }
    return serializedShapeFits(obj) ? targets : null
  } catch {
    return null
  }
}
