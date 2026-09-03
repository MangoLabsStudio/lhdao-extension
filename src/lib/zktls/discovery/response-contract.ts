import type { DiscoveryRequest } from '../../product-experience-task-bridge'
import { DISCOVERY_LIMITS } from './candidate-store'
import {
  BODY_LIMIT,
  byteLength,
  freezeCopy,
  type Json,
  publicHeaders,
  REDACTED,
  redact,
  redactUrl,
  safeClone,
} from './redaction'
import type { DiscoveryResponse } from './session-manager'

const codes = new Set([
  'INVALID_REQUEST',
  'INVALID_SENDER',
  'NO_SESSION',
  'BUSY',
  'ATTACH_FAILED',
  'DETACHED',
  'ORIGIN_CHANGED',
  'OWNER_NAVIGATED',
  'TAB_CLOSED',
  'EXPIRED',
  'QUOTA_REACHED',
  'STOPPED',
  'EXTENSION_ERROR',
])
const bodyStates = new Set([
  'json',
  'empty',
  'non-json',
  'oversize',
  'unavailable',
  'invalid',
])
const unsupported = new Set([
  'RESPONSE_NOT_JSON',
  'REQUEST_UNSUPPORTED',
  'UNSAFE_TRIGGER_PATH',
  'AUTH_HEADERS_UNSUPPORTED',
])
type RecordValue = Record<string, unknown>
function record(value: unknown): value is RecordValue {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
function exact(value: unknown, keys: string[]): value is RecordValue {
  return (
    record(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  )
}
function text(value: unknown, max = 4096): value is string {
  if (typeof value !== 'string' || value.length > max) return false
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code < 32 || code === 127) return false
  }
  return true
}
function id(value: unknown): value is string {
  return text(value, 128) && /^[A-Za-z0-9_-]+$/.test(value)
}
function integer(
  value: unknown,
  max = Number.MAX_SAFE_INTEGER,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= max
  )
}
function list(value: unknown, max: number): value is unknown[] {
  return (
    Array.isArray(value) &&
    value.length <= max &&
    Object.keys(value).length === value.length &&
    Object.keys(value).every((key, index) => key === String(index))
  )
}
function origin(value: unknown, https = false): value is string {
  if (!text(value)) return false
  try {
    const url = new URL(value)
    return (
      url.origin === value &&
      (url.protocol === 'https:' || (!https && url.protocol === 'http:'))
    )
  } catch {
    return false
  }
}
function safeUrl(value: string, allowMarkers = true) {
  try {
    const url = new URL(value)
    if (!origin(url.origin) || url.username || url.password || url.hash)
      return false
    const query = new URLSearchParams(
      [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)),
    )
    const normalized = `${url.origin}${url.pathname}${query.size ? `?${query}` : ''}`
    const redacted = redactUrl(value)
    return (
      redacted?.url === normalized &&
      (allowMarkers ||
        (!normalized.includes(REDACTED) &&
          !normalized.includes(encodeURIComponent(REDACTED))))
    )
  } catch {
    return false
  }
}
function json(value: unknown): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return list(value, BODY_LIMIT) && value.every(json)
  return record(value) && Object.values(value).every(json)
}
function safeJson(value: unknown, max = BODY_LIMIT): value is Json {
  if (!json(value)) return false
  const encoded = JSON.stringify(value)
  return byteLength(encoded) <= max && JSON.stringify(redact(value)) === encoded
}
function body(value: unknown, state: unknown, bytes: unknown) {
  return (
    typeof state === 'string' &&
    bodyStates.has(state) &&
    integer(bytes, BODY_LIMIT + 1) &&
    (state === 'json' ? safeJson(value) : value === null)
  )
}
function headers(value: unknown, response = false) {
  return (
    record(value) &&
    Object.keys(value).length <= 12 &&
    Object.values(value).every((item) => text(item, 256)) &&
    Object.keys(value).every((key) => key === key.toLowerCase()) &&
    JSON.stringify(Object.entries(value).sort()) ===
      JSON.stringify(Object.entries(publicHeaders(value, response)).sort())
  )
}
function stringMap(value: unknown, shape = false) {
  return (
    record(value) &&
    Object.entries(value).every(
      ([key, item]) =>
        text(key) &&
        text(item) &&
        (!shape ||
          /^(?:null|boolean|number|string|array|object)(?:\|(?:null|boolean|number|string|array|object))*$/.test(
            item,
          )),
    )
  )
}
function sample(value: unknown, pageOrigin: string) {
  if (
    !exact(value, [
      'at',
      'pageOrigin',
      'triggerPath',
      'triggerPathSafe',
      'request',
      'response',
      'responseBodyState',
      'responseBodyBytes',
      'responseHeaders',
      'status',
    ])
  )
    return false
  if (
    !integer(value.at) ||
    value.pageOrigin !== pageOrigin ||
    !text(value.triggerPath) ||
    !value.triggerPath.startsWith('/') ||
    typeof value.triggerPathSafe !== 'boolean' ||
    !integer(value.status, 599)
  )
    return false
  if (!safeUrl(pageOrigin + value.triggerPath, !value.triggerPathSafe))
    return false
  const request = value.request
  if (
    !exact(request, [
      'method',
      'url',
      'contentType',
      'headers',
      'body',
      'bodyState',
      'bodyBytes',
    ]) ||
    !text(request.method, 16) ||
    !/^[A-Z]+$/.test(request.method) ||
    !text(request.url) ||
    !text(request.contentType, 256) ||
    !headers(request.headers) ||
    !body(request.body, request.bodyState, request.bodyBytes)
  )
    return false
  if (!safeUrl(request.url)) return false
  return (
    headers(value.responseHeaders, true) &&
    body(value.response, value.responseBodyState, value.responseBodyBytes)
  )
}
function candidate(value: unknown, pageOrigin: string) {
  if (
    !exact(value, [
      'candidateId',
      'method',
      'origin',
      'path',
      'queryNames',
      'contentType',
      'requestContentType',
      'occurrences',
      'firstSeenAt',
      'lastSeenAt',
      'samples',
      'inference',
      'configurable',
      'unsupportedReason',
    ])
  )
    return false
  if (
    !id(value.candidateId) ||
    !text(value.method, 16) ||
    !/^[A-Z]+$/.test(value.method) ||
    !origin(value.origin) ||
    !text(value.path) ||
    !value.path.startsWith('/') ||
    !list(value.queryNames, 1024) ||
    !value.queryNames.every((name) => text(name)) ||
    new Set(value.queryNames).size !== value.queryNames.length ||
    !['application/json', 'other'].includes(value.contentType as string) ||
    !text(value.requestContentType, 256) ||
    !integer(value.occurrences) ||
    value.occurrences < 1 ||
    !integer(value.firstSeenAt) ||
    !integer(value.lastSeenAt) ||
    value.lastSeenAt < value.firstSeenAt ||
    typeof value.configurable !== 'boolean' ||
    !(
      value.unsupportedReason === null ||
      (typeof value.unsupportedReason === 'string' &&
        unsupported.has(value.unsupportedReason))
    ) ||
    value.configurable !== (value.unsupportedReason === null)
  )
    return false
  if (
    !list(value.samples, DISCOVERY_LIMITS.samplesPerCandidate) ||
    value.samples.length < 1 ||
    value.samples.length > value.occurrences ||
    !value.samples.every((item) => sample(item, pageOrigin))
  )
    return false
  const inference = value.inference
  return (
    exact(inference, [
      'requestShape',
      'responseShape',
      'dynamicFields',
      'stableEnums',
    ]) &&
    stringMap(inference.requestShape, true) &&
    stringMap(inference.responseShape, true) &&
    list(inference.dynamicFields, 20_000) &&
    inference.dynamicFields.every((key) => text(key)) &&
    record(inference.stableEnums) &&
    Object.values(inference.stableEnums).every(
      (value) =>
        value === null ||
        ['string', 'boolean', 'number'].includes(typeof value),
    ) &&
    safeJson(inference.stableEnums, DISCOVERY_LIMITS.sessionBytes)
  )
}

/** Shared, exact trust boundary for background -> page consumers. No native APIs. */
export function parseDiscoveryResponse(
  input: unknown,
  request: DiscoveryRequest,
): DiscoveryResponse | null {
  try {
    // Descriptor validation precedes clone: getters never execute; proxies fail clone.
    const value = safeClone(input, DISCOVERY_LIMITS.sessionBytes, 1_000_000, 48)
    if (
      !record(value) ||
      byteLength(JSON.stringify(value)) > DISCOVERY_LIMITS.sessionBytes ||
      value.type !== 'discovery-result' ||
      value.requestType !== request.type ||
      value.correlationId !== request.correlationId ||
      typeof value.ok !== 'boolean'
    )
      return null
    if (!value.ok)
      return exact(value, [
        'type',
        'requestType',
        'correlationId',
        'ok',
        'code',
      ]) &&
        typeof value.code === 'string' &&
        codes.has(value.code)
        ? (freezeCopy(value) as DiscoveryResponse)
        : null
    if (
      !exact(value, ['type', 'requestType', 'correlationId', 'ok', 'snapshot'])
    )
      return null
    const state = value.snapshot
    if (
      !exact(state, [
        'schema',
        'sessionId',
        'pageOrigin',
        'status',
        'reason',
        'startedAt',
        'expiresAt',
        'candidates',
        'quota',
      ]) ||
      state.schema !== 1 ||
      !id(state.sessionId) ||
      !origin(state.pageOrigin, true) ||
      !['ready', 'stopped'].includes(state.status as string) ||
      !(
        state.reason === null ||
        (typeof state.reason === 'string' && codes.has(state.reason))
      ) ||
      !integer(state.startedAt) ||
      !integer(state.expiresAt) ||
      state.expiresAt - state.startedAt !== 900_000
    )
      return null
    if (
      request.type === 'start-discovery'
        ? state.pageOrigin !== new URL(request.targetUrl).origin
        : state.sessionId !== request.sessionId
    )
      return null
    if (
      state.status === 'ready' ? state.reason !== null : state.reason === null
    )
      return null
    if (request.type === 'stop-discovery' && state.status !== 'stopped')
      return null
    if (
      !list(state.candidates, DISCOVERY_LIMITS.candidates) ||
      !state.candidates.every((item) =>
        candidate(item, state.pageOrigin as string),
      ) ||
      new Set(state.candidates.map((item) => (item as RecordValue).candidateId))
        .size !== state.candidates.length ||
      (state.status === 'stopped' && state.candidates.length !== 0)
    )
      return null
    const quota = state.quota
    if (
      !exact(quota, ['bytes', 'limits']) ||
      !integer(quota.bytes, DISCOVERY_LIMITS.sessionBytes) ||
      !exact(quota.limits, Object.keys(DISCOVERY_LIMITS)) ||
      !Object.entries(DISCOVERY_LIMITS).every(
        ([key, number]) => (quota.limits as RecordValue)[key] === number,
      ) ||
      (state.status === 'stopped' && quota.bytes !== 0)
    )
      return null
    return freezeCopy(value) as DiscoveryResponse
  } catch {
    return null
  }
}
