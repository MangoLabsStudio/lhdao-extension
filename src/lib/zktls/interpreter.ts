import {
  type BodyMatcher,
  normalizePathQuery,
  type RequestMatcher,
  SECRET_HEADERS,
  validateBodyMatcher,
  validateRequestMatcher,
} from './capture'
import {
  type ProviderAction,
  validateProviderActions,
} from './provider-actions'

const encoder = new TextEncoder()
const MAX_SENT_DATA = 8192
const MAX_RECV_DATA = 65536
const IDENTITY_TOKEN = '${' + 'identity}'
const ALLOWED_HEADERS: Record<string, Set<string>> = {
  accept: new Set(['application/json', 'text/fragment+html']),
  'x-requested-with': new Set(['XMLHttpRequest']),
}

export type V1Connector = {
  interpreter_version: 1
  connector_id: string
  revision: number
  disabled: boolean
  expires_at: string
  origin: string
  identity_source: { kind: 'html_meta'; name: string; max_bytes: number }
  request: {
    method: 'GET'
    path_template: string
    headers: Record<string, string>
    max_sent_data: number
    max_recv_data: number
  }
  response_format: 'json' | 'html'
  response_status: number
  extraction:
    | { kind: 'json_pointer'; pointer: string }
    | {
        kind: 'html_literal_window'
        start: string
        end: string
        claim: '${identity}'
      }
  verifier_profile_id: string
}

export type V2Connector = {
  interpreter_version: 2
  connector_id: string
  revision: number
  disabled: boolean
  expires_at: string
  origin: string
  request: {
    method: 'GET'
    path: string
    headers: Record<string, string>
    secret_headers: (
      | 'cookie'
      | 'authorization'
      | 'x-csrf-token'
      | 'x-xsrf-token'
    )[]
    max_sent_data: number
    max_recv_data: number
    replay_safety_evidence: string
  }
  response_format: 'html'
  response_status: number
  extraction: {
    kind: 'html_between'
    prefix: string
    suffix: string
    max_bytes: number
  }
  verifier_profile_id: string
}

export type V3Connector = {
  interpreter_version: 3
  connector_id: string
  revision: number
  disabled: boolean
  expires_at: string
  origin: string
  request: {
    method: 'GET' | 'POST'
    matcher: RequestMatcher
    body?: BodyMatcher
    headers: Record<string, string>
    secret_headers: (
      | 'cookie'
      | 'authorization'
      | 'x-csrf-token'
      | 'x-xsrf-token'
    )[]
    max_sent_data: number
    max_recv_data: number
    replay_safety_evidence: string
  }
  response_format: 'html' | 'json'
  response_status: number
  extraction:
    | {
        kind: 'html_between'
        prefix: string
        suffix: string
        max_bytes: number
      }
    | { kind: 'regex'; pattern: string; max_bytes: number }
    | {
        kind: 'json_path'
        path: string
        value_type: 'string' | 'number' | 'boolean'
        max_bytes: number
      }
  actions?: ProviderAction[]
  verifier_profile_id: string
}

export type CapturedConnector = V2Connector | V3Connector
export type Connector = V1Connector | CapturedConnector

function fail(message: string): never {
  throw new Error(message)
}

function bytes(value: string): number {
  return encoder.encode(value).length
}

function object(
  value: unknown,
  name: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} must be an object.`)
}

function keys(value: unknown, allowed: string[], name: string): void {
  object(value, name)
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) fail(`${name} contains an unknown field.`)
}

function required(
  value: Record<string, unknown>,
  names: string[],
  name: string,
): void {
  for (const field of names)
    if (!(field in value)) fail(`${name}.${field} is required.`)
}

function string(
  value: unknown,
  name: string,
  max = 256,
): asserts value is string {
  if (typeof value !== 'string' || !value || bytes(value) > max)
    fail(`${name} must be a bounded string.`)
}

function positiveInteger(
  value: unknown,
  name: string,
  max: number,
): asserts value is number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < 1 ||
    value > max
  )
    fail(`${name} is outside its allowed range.`)
}

function publicDnsHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  const labels = host.split('.')
  const numeric =
    labels.length === 4 && labels.every((label) => /^\d+$/.test(label))
  if (
    host.includes(':') ||
    numeric ||
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local')
  )
    return false
  return (
    host.includes('.') &&
    host.length <= 253 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label),
    )
  )
}

function validateOrigin(value: unknown): void {
  string(value, 'origin')
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail('origin must be an exact HTTPS origin.')
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== value ||
    !publicDnsHost(url.hostname)
  )
    fail('origin must be a public HTTPS DNS origin.')
}

function validPathTemplate(value: unknown): void {
  string(value, 'request.path_template', 2048)
  if (
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('://') ||
    value.includes('#')
  )
    fail('request.path_template must be relative.')
  if (
    value.replaceAll(IDENTITY_TOKEN, '').includes('{') ||
    value.replaceAll(IDENTITY_TOKEN, '').includes('}')
  )
    fail('request.path_template has an unsupported variable.')
  if ([...value].some((char) => char <= ' ' || char === '\\'))
    fail('request.path_template contains an unsafe character.')
}

function validateHeaders(value: unknown): void {
  keys(value, Object.keys(ALLOWED_HEADERS), 'request.headers')
  object(value, 'request.headers')
  for (const [name, headerValue] of Object.entries(value))
    if (!ALLOWED_HEADERS[name]?.has(headerValue as string))
      fail('request.headers contains a non-allowlisted literal.')
}

function validateIdentitySource(value: unknown): void {
  keys(value, ['kind', 'name', 'max_bytes'], 'identity_source')
  object(value, 'identity_source')
  required(value, ['kind', 'name', 'max_bytes'], 'identity_source')
  if (value.kind !== 'html_meta') fail('identity_source.kind is unsupported.')
  string(value.name, 'identity_source.name', 64)
  if (!/^[A-Za-z0-9_-]+$/.test(value.name))
    fail('identity_source.name must be a token.')
  positiveInteger(value.max_bytes, 'identity_source.max_bytes', 256)
}

function parsePointer(pointer: string): string[] {
  if (pointer === '') return []
  if (!pointer.startsWith('/')) fail('JSON Pointer must start with /.')
  return pointer
    .slice(1)
    .split('/')
    .map((token) => {
      if (bytes(token) > 64) fail('JSON Pointer token is invalid.')
      return token.replace(/~./g, (pair) =>
        pair === '~0'
          ? '~'
          : pair === '~1'
            ? '/'
            : fail('JSON Pointer token is invalid.'),
      )
    })
}

type JsonPathToken = string | number

function parseJsonPath(path: string): JsonPathToken[] {
  if (path === '$') return []
  if (!path.startsWith('$')) fail('JSONPath must start with $.')
  const tokens: JsonPathToken[] = []
  let at = 1
  while (at < path.length) {
    if (path[at] === '.') {
      const match = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(path.slice(at + 1))
      if (!match) fail('JSONPath has an invalid object key.')
      tokens.push(match[0])
      at += match[0].length + 1
    } else if (path[at] === '[') {
      const rest = path.slice(at)
      const index = /^\[(0|[1-9]\d*)\]/.exec(rest)
      if (index) {
        tokens.push(Number(index[1]))
        at += index[0].length
      } else {
        const key = /^\[['"]([A-Za-z0-9_$-]+)['"]\]/.exec(rest)
        if (!key) fail('JSONPath has an invalid bracket key.')
        tokens.push(key[1])
        at += key[0].length
      }
    } else {
      fail('JSONPath has unsupported syntax.')
    }
    if (tokens.length > 32) fail('JSONPath is too deep.')
  }
  return tokens
}

const REGEX_CONTEXT_META = new Set('.^$*+?()[]{}|')

function validateFixedRegexContext(value: string): void {
  for (let at = 0; at < value.length; at += 1) {
    const char = value[at]
    if (char === '\\') {
      const escaped = value[at + 1]
      if (escaped === 's' && value[at + 2] === '*') {
        at += 2
        continue
      }
      if (
        escaped &&
        (REGEX_CONTEXT_META.has(escaped) ||
          escaped === '\\' ||
          escaped === '/' ||
          escaped === '"' ||
          escaped === "'" ||
          escaped === '-' ||
          /[nrt]/.test(escaped))
      ) {
        at += 1
        continue
      }
      fail('regex outside its capture must be fixed context.')
    }
    if (REGEX_CONTEXT_META.has(char))
      fail('regex outside its capture must be fixed context.')
  }
}

function validateRegexContext(prefix: string, suffix: string): void {
  const lineBoundary = '(?:^|\\n)'
  const fixedPrefix = prefix.startsWith(lineBoundary)
    ? prefix.slice(lineBoundary.length)
    : prefix.startsWith('^')
      ? prefix.slice(1)
      : prefix
  const fixedSuffix = suffix.endsWith('$') ? suffix.slice(0, -1) : suffix
  validateFixedRegexContext(fixedPrefix)
  validateFixedRegexContext(fixedSuffix)
}

function validateRegex(pattern: string): void {
  if (
    pattern.includes('\n') ||
    pattern.includes('\r') ||
    /\\[1-9]/.test(pattern)
  )
    fail('regex has unsupported syntax.')
  let captures = 0
  let captureOpen = -1
  let captureClose = -1
  let escaped = false
  let inClass = false
  const groups: { capture: boolean }[] = []
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '[') {
      inClass = true
      continue
    }
    if (char === ']') {
      inClass = false
      continue
    }
    if (inClass) continue
    if (char === '(') {
      const special = pattern[at + 1] === '?'
      if (special && pattern[at + 2] !== ':')
        fail('regex has unsupported syntax.')
      const capture = !special
      groups.push({ capture })
      if (capture) {
        captures += 1
        captureOpen = at
      }
      continue
    }
    if (char === ')') {
      const group = groups.pop()
      if (!group) fail('regex is invalid.')
      if (group.capture) {
        captureClose = at
        if (/[+*?{]/.test(pattern[at + 1] ?? ''))
          fail('regex cannot quantify its capture.')
      }
    }
  }
  if (escaped || groups.length || captures !== 1)
    fail('regex must have one capture group.')
  validateRegexContext(
    pattern.slice(0, captureOpen),
    pattern.slice(captureClose + 1),
  )
  try {
    new RegExp(pattern, 'd')
  } catch {
    fail('regex is invalid.')
  }
}

function validateHtmlBetween(value: Record<string, unknown>): void {
  keys(value, ['kind', 'prefix', 'suffix', 'max_bytes'], 'extraction')
  required(value, ['kind', 'prefix', 'suffix', 'max_bytes'], 'extraction')
  if (value.kind !== 'html_between') fail('extraction.kind is unsupported.')
  string(value.prefix, 'extraction.prefix', 256)
  string(value.suffix, 'extraction.suffix', 256)
  if (value.prefix === value.suffix) fail('extraction bounds must differ.')
  positiveInteger(value.max_bytes, 'extraction.max_bytes', 1024)
}

function validateV3Extraction(value: unknown, responseFormat: unknown): void {
  object(value, 'extraction')
  const extraction = value as Record<string, unknown>
  string(extraction.kind, 'extraction.kind', 64)
  if (extraction.kind === 'html_between') {
    if (responseFormat !== 'html') fail('HTML extraction requires HTML.')
    validateHtmlBetween(extraction)
    return
  }
  if (extraction.kind === 'regex') {
    if (responseFormat !== 'html' && responseFormat !== 'json')
      fail('regex extraction requires text.')
    keys(extraction, ['kind', 'pattern', 'max_bytes'], 'extraction')
    required(extraction, ['kind', 'pattern', 'max_bytes'], 'extraction')
    string(extraction.pattern, 'extraction.pattern', 256)
    validateRegex(extraction.pattern)
    positiveInteger(extraction.max_bytes, 'extraction.max_bytes', 1024)
    return
  }
  if (extraction.kind === 'json_path') {
    if (responseFormat !== 'json') fail('JSONPath extraction requires JSON.')
    keys(extraction, ['kind', 'path', 'value_type', 'max_bytes'], 'extraction')
    required(
      extraction,
      ['kind', 'path', 'value_type', 'max_bytes'],
      'extraction',
    )
    string(extraction.path, 'extraction.path', 512)
    parseJsonPath(extraction.path)
    if (
      extraction.value_type !== 'string' &&
      extraction.value_type !== 'number' &&
      extraction.value_type !== 'boolean'
    )
      fail('JSONPath value_type is unsupported.')
    positiveInteger(extraction.max_bytes, 'extraction.max_bytes', 1024)
    return
  }
  fail('extraction.kind is unsupported.')
}

function validateExtraction(config: Record<string, unknown>): void {
  const extraction = config.extraction
  keys(extraction, ['kind', 'pointer', 'start', 'end', 'claim'], 'extraction')
  object(extraction, 'extraction')
  string(extraction.kind, 'extraction.kind', 64)
  if (extraction.kind === 'json_pointer') {
    if (
      config.response_format !== 'json' ||
      Object.keys(extraction).length !== 2
    )
      fail('JSON Pointer fields are invalid.')
    string(extraction.pointer, 'extraction.pointer', 512)
    parsePointer(extraction.pointer)
    return
  }
  if (extraction.kind === 'html_literal_window') {
    if (
      config.response_format !== 'html' ||
      Object.keys(extraction).length !== 4 ||
      extraction.claim !== IDENTITY_TOKEN
    )
      fail('HTML literal window fields are invalid.')
    string(extraction.start, 'extraction.start', 128)
    string(extraction.end, 'extraction.end', 128)
    return
  }
  fail('extraction.kind is unsupported.')
}

function validateV1Connector(value: unknown): V1Connector {
  keys(
    value,
    [
      'interpreter_version',
      'connector_id',
      'revision',
      'disabled',
      'expires_at',
      'origin',
      'identity_source',
      'request',
      'response_format',
      'response_status',
      'extraction',
      'verifier_profile_id',
    ],
    'connector',
  )
  object(value, 'connector')
  required(
    value,
    [
      'interpreter_version',
      'connector_id',
      'revision',
      'disabled',
      'expires_at',
      'origin',
      'identity_source',
      'request',
      'response_format',
      'response_status',
      'extraction',
      'verifier_profile_id',
    ],
    'connector',
  )
  if (value.interpreter_version !== 1)
    fail('interpreter_version is unsupported.')
  string(value.connector_id, 'connector_id', 128)
  positiveInteger(value.revision, 'revision', Number.MAX_SAFE_INTEGER)
  if (typeof value.disabled !== 'boolean') fail('disabled must be boolean.')
  string(value.expires_at, 'expires_at', 64)
  if (
    !Number.isFinite(Date.parse(value.expires_at)) ||
    new Date(value.expires_at).toISOString() !== value.expires_at
  )
    fail('expires_at is invalid.')
  validateOrigin(value.origin)
  validateIdentitySource(value.identity_source)
  keys(
    value.request,
    ['method', 'path_template', 'headers', 'max_sent_data', 'max_recv_data'],
    'request',
  )
  object(value.request, 'request')
  required(
    value.request,
    ['method', 'path_template', 'headers', 'max_sent_data', 'max_recv_data'],
    'request',
  )
  if (value.request.method !== 'GET') fail('request.method must be GET.')
  validPathTemplate(value.request.path_template)
  validateHeaders(value.request.headers)
  positiveInteger(
    value.request.max_sent_data,
    'request.max_sent_data',
    MAX_SENT_DATA,
  )
  positiveInteger(
    value.request.max_recv_data,
    'request.max_recv_data',
    MAX_RECV_DATA,
  )
  if (value.response_format !== 'json' && value.response_format !== 'html')
    fail('response_format is unsupported.')
  if (
    typeof value.response_status !== 'number' ||
    !Number.isInteger(value.response_status) ||
    value.response_status < 100 ||
    value.response_status > 599
  )
    fail('response_status must be an HTTP status code.')
  validateExtraction(value)
  string(value.verifier_profile_id, 'verifier_profile_id', 128)
  return value as V1Connector
}

function validateV2Headers(value: unknown): void {
  keys(value, Object.keys(ALLOWED_HEADERS), 'request.headers')
  object(value, 'request.headers')
  for (const [name, headerValue] of Object.entries(value))
    if (!ALLOWED_HEADERS[name]?.has(headerValue as string))
      fail('request.headers contains a non-allowlisted literal.')
}

function validateCapturedRequest(value: unknown, version: 2 | 3): void {
  object(value, 'request')
  const request = value as Record<string, unknown>
  const method = request.method
  if (method !== 'GET' && (version !== 3 || method !== 'POST'))
    fail('request.method is unsupported.')
  const allowed = [
    'method',
    ...(version === 2 ? ['path'] : ['matcher']),
    ...(method === 'POST' ? ['body'] : []),
    'headers',
    'secret_headers',
    'max_sent_data',
    'max_recv_data',
    'replay_safety_evidence',
  ]
  keys(value, allowed, 'request')
  required(value, allowed, 'request')
  if (version === 2) {
    string(value.path, 'request.path', 2048)
    normalizePathQuery(value.path)
  } else {
    validateRequestMatcher(value.matcher)
    if (method === 'POST') validateBodyMatcher(value.body)
  }
  validateV2Headers(value.headers)
  if (!Array.isArray(value.secret_headers))
    fail('request.secret_headers must be an array.')
  if (
    value.secret_headers.length === 0 ||
    value.secret_headers.some(
      (header) =>
        typeof header !== 'string' ||
        !SECRET_HEADERS.includes(header as (typeof SECRET_HEADERS)[number]),
    ) ||
    new Set(value.secret_headers).size !== value.secret_headers.length
  )
    fail('request.secret_headers contains an unsupported header.')
  positiveInteger(value.max_sent_data, 'request.max_sent_data', MAX_SENT_DATA)
  positiveInteger(value.max_recv_data, 'request.max_recv_data', MAX_RECV_DATA)
  string(value.replay_safety_evidence, 'request.replay_safety_evidence', 1024)
}

function validateCapturedConnector(value: unknown, version: 2 | 3): void {
  keys(
    value,
    [
      'interpreter_version',
      'connector_id',
      'revision',
      'disabled',
      'expires_at',
      'origin',
      'request',
      'response_format',
      'response_status',
      'extraction',
      ...(version === 3 ? ['actions'] : []),
      'verifier_profile_id',
    ],
    'connector',
  )
  object(value, 'connector')
  required(
    value,
    [
      'interpreter_version',
      'connector_id',
      'revision',
      'disabled',
      'expires_at',
      'origin',
      'request',
      'response_format',
      'response_status',
      'extraction',
      'verifier_profile_id',
    ],
    'connector',
  )
  if (value.interpreter_version !== version)
    fail('interpreter_version is unsupported.')
  string(value.connector_id, 'connector_id', 128)
  positiveInteger(value.revision, 'revision', Number.MAX_SAFE_INTEGER)
  if (typeof value.disabled !== 'boolean') fail('disabled must be boolean.')
  string(value.expires_at, 'expires_at', 64)
  if (
    !Number.isFinite(Date.parse(value.expires_at)) ||
    new Date(value.expires_at).toISOString() !== value.expires_at
  )
    fail('expires_at is invalid.')
  validateOrigin(value.origin)
  validateCapturedRequest(value.request, version)
  if (version === 3 && 'actions' in value)
    validateProviderActions(value.actions)
  if (
    value.response_format !== 'html' &&
    (version !== 3 || value.response_format !== 'json')
  )
    fail('response_format is unsupported.')
  if (
    typeof value.response_status !== 'number' ||
    !Number.isInteger(value.response_status) ||
    value.response_status < 100 ||
    value.response_status > 599
  )
    fail('response_status must be an HTTP status code.')
  object(value.extraction, 'extraction')
  if (version === 2) validateHtmlBetween(value.extraction)
  else validateV3Extraction(value.extraction, value.response_format)
  string(value.verifier_profile_id, 'verifier_profile_id', 128)
}

function validateV2Connector(value: unknown): V2Connector {
  validateCapturedConnector(value, 2)
  return value as V2Connector
}

function validateV3Connector(value: unknown): V3Connector {
  validateCapturedConnector(value, 3)
  return value as V3Connector
}

export function validateConnector(value: unknown): Connector {
  object(value, 'connector')
  if (value.interpreter_version === 1) return validateV1Connector(value)
  if (value.interpreter_version === 2) return validateV2Connector(value)
  if (value.interpreter_version === 3) return validateV3Connector(value)
  fail('interpreter_version is unsupported.')
}

export function assertConnectorAvailable(config: Connector, now: string): void {
  validateConnector(config)
  const current = Date.parse(now)
  if (
    !Number.isFinite(current) ||
    config.disabled ||
    Date.parse(config.expires_at) <= current
  )
    fail('connector is unavailable.')
}

export function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value))
      fail('canonical JSON does not support non-finite numbers.')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  object(value, 'canonical JSON value')
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

export async function configDigest(config: unknown): Promise<string> {
  validateConnector(config)
  const digest = await crypto.subtle.digest(
    'SHA-256',
    encoder.encode(canonicalJson(config)),
  )
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, '0'),
  ).join('')
}

export function extractIdentity(config: V1Connector, entries: unknown): string {
  validateConnector(config)
  if (!Array.isArray(entries)) fail('metaEntries must be an array.')
  let identity: string | undefined
  for (const entry of entries) {
    keys(entry, ['name', 'content'], 'meta entry')
    object(entry, 'meta entry')
    if (typeof entry.name !== 'string' || typeof entry.content !== 'string')
      fail('meta entry fields must be strings.')
    if (entry.name === config.identity_source.name) {
      if (identity !== undefined) fail('identity meta entry was duplicated.')
      identity = entry.content
    }
  }
  if (!identity || bytes(identity) > config.identity_source.max_bytes)
    fail('identity meta entry was missing or exceeds its limit.')
  return identity
}

export function requestTarget(config: V1Connector, identity: string): string {
  validateConnector(config)
  string(identity, 'identity', 256)
  const target = config.request.path_template.replaceAll(
    IDENTITY_TOKEN,
    encodeURIComponent(identity),
  )
  if (
    !target.startsWith('/') ||
    target.startsWith('//') ||
    target.includes('://') ||
    target.includes('#')
  )
    fail('request target is unsafe.')
  return target
}

export function htmlDisclosureRanges(
  config: V1Connector,
  response: string,
  identity: string,
): {
  marker: { start: number; end: number }
  end: { start: number; end: number }
  claim: { start: number; end: number }
} {
  validateConnector(config)
  if (
    config.response_format !== 'html' ||
    config.extraction.kind !== 'html_literal_window'
  )
    fail('HTML disclosure requires an HTML literal window.')
  const { start: marker, end } = config.extraction
  const markerAt = response.indexOf(marker)
  if (markerAt < 0 || response.indexOf(marker, markerAt + marker.length) >= 0)
    fail('HTML marker was ambiguous.')
  const windowStart = markerAt + marker.length
  const endAt = response.indexOf(end, windowStart)
  const claimAt = response.indexOf(identity, windowStart)
  if (
    endAt < 0 ||
    bytes(response.slice(windowStart, endAt)) > 1024 ||
    claimAt < windowStart ||
    claimAt >= endAt ||
    response.indexOf(identity, claimAt + identity.length) >= 0
  )
    fail('HTML claim was ambiguous.')
  const range = (at: number, value: string) => ({
    start: bytes(response.slice(0, at)),
    end: bytes(response.slice(0, at)) + bytes(value),
  })
  return {
    marker: range(markerAt, marker),
    end: range(endAt, end),
    claim: range(claimAt, identity),
  }
}

export function interpret(
  config: V1Connector,
  input: { response: string; status: number; identity: string; now: string },
): { request_target: string; status: string; marker: string; claim: string } {
  validateConnector(config)
  assertConnectorAvailable(config, input.now)
  if (
    typeof input.response !== 'string' ||
    bytes(input.response) > config.request.max_recv_data ||
    input.status !== config.response_status
  )
    fail('response did not match the signed connector.')
  let claim: string
  let marker: string
  if (config.extraction.kind === 'json_pointer') {
    let value: unknown
    try {
      value = JSON.parse(input.response)
    } catch {
      fail('JSON response could not be parsed.')
    }
    for (const token of parsePointer(config.extraction.pointer)) {
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, token))
        fail('JSON Pointer did not resolve.')
      value = (value as Record<string, unknown>)[token]
    }
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      bytes(JSON.stringify(value)) > 256
    )
      fail('JSON Pointer result is invalid.')
    claim = String(value)
    marker = config.extraction.pointer
  } else {
    htmlDisclosureRanges(config, input.response, input.identity)
    claim = input.identity
    marker = config.extraction.start
  }
  return {
    request_target: requestTarget(config, input.identity),
    status: String(input.status),
    marker,
    claim,
  }
}

export function htmlBetweenDisclosureRanges(
  config: CapturedConnector,
  response: string,
): {
  prefix: { start: number; end: number }
  value: { start: number; end: number }
  suffix: { start: number; end: number }
  claim: string
} {
  validateConnector(config)
  const extraction = config.extraction
  if (extraction.kind !== 'html_between')
    fail('HTML disclosure requires html_between.')
  const { prefix, suffix, max_bytes: maxBytes } = extraction
  const prefixAt = response.indexOf(prefix)
  if (prefixAt < 0 || response.indexOf(prefix, prefixAt + prefix.length) >= 0)
    fail('HTML prefix was ambiguous.')
  const valueAt = prefixAt + prefix.length
  const suffixAt = response.indexOf(suffix, valueAt)
  if (
    suffixAt < 0 ||
    response.indexOf(suffix, suffixAt + suffix.length) >= 0 ||
    bytes(response.slice(valueAt, suffixAt)) > maxBytes
  )
    fail('HTML suffix was ambiguous.')
  const range = (at: number, value: string) => ({
    start: bytes(response.slice(0, at)),
    end: bytes(response.slice(0, at)) + bytes(value),
  })
  return {
    prefix: range(prefixAt, prefix),
    value: range(valueAt, response.slice(valueAt, suffixAt)),
    suffix: range(suffixAt, suffix),
    claim: response.slice(valueAt, suffixAt),
  }
}

export function regexDisclosureRanges(
  config: V3Connector,
  response: string,
): {
  prefix: { start: number; end: number }
  value: { start: number; end: number }
  suffix: { start: number; end: number }
  claim: string
} {
  validateConnector(config)
  if (config.extraction.kind !== 'regex')
    fail('regex disclosure requires a regex selector.')
  const matches = new RegExp(config.extraction.pattern, 'gd')
  const first = matches.exec(response)
  const second = matches.exec(response)
  const indices = first?.indices?.[1]
  if (!first || second || !indices || first[1] === undefined || !first[1])
    fail('regex result was ambiguous.')
  if (bytes(first[1]) > config.extraction.max_bytes)
    fail('regex result exceeds its limit.')
  const range = (start: number, end: number) => ({
    start: bytes(response.slice(0, start)),
    end: bytes(response.slice(0, end)),
  })
  return {
    prefix: range(first.index, indices[0]),
    value: range(indices[0], indices[1]),
    suffix: range(indices[1], first.index + first[0].length),
    claim: first[1],
  }
}

export function jsonPathClaim(config: V3Connector, response: string): string {
  validateConnector(config)
  if (
    config.response_format !== 'json' ||
    config.extraction.kind !== 'json_path'
  )
    fail('JSONPath claim requires a JSON selector.')
  let value: unknown
  try {
    value = JSON.parse(response)
  } catch {
    fail('JSON response could not be parsed.')
  }
  for (const token of parseJsonPath(config.extraction.path)) {
    if (typeof token === 'number') {
      if (!Array.isArray(value) || token >= value.length)
        fail('JSONPath did not resolve.')
      value = value[token]
    } else {
      if (
        !value ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        !Object.hasOwn(value, token)
      )
        fail('JSONPath did not resolve.')
      value = (value as Record<string, unknown>)[token]
    }
  }
  if (
    typeof value !== config.extraction.value_type ||
    (typeof value === 'number' && !Number.isFinite(value))
  )
    fail('JSONPath result has the wrong type.')
  const claim = String(value)
  if (bytes(claim) > config.extraction.max_bytes)
    fail('JSONPath result exceeds its limit.')
  return claim
}

export function interpretCaptured(
  config: CapturedConnector,
  input: {
    response: string
    status: number
    now: string
    request_target: string
  },
): { request_target: string; status: string; claim: string } {
  validateConnector(config)
  assertConnectorAvailable(config, input.now)
  if (
    typeof input.response !== 'string' ||
    bytes(input.response) > config.request.max_recv_data ||
    input.status !== config.response_status
  )
    fail('response did not match the signed provider.')
  const disclosure =
    config.interpreter_version === 3 && config.extraction.kind === 'json_path'
      ? { claim: jsonPathClaim(config, input.response) }
      : config.interpreter_version === 3 && config.extraction.kind === 'regex'
        ? regexDisclosureRanges(config, input.response)
        : htmlBetweenDisclosureRanges(config, input.response)
  return {
    request_target: input.request_target,
    status: String(input.status),
    claim: disclosure.claim,
  }
}
