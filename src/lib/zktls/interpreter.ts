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

export type V4ScalarType =
  | 'STRING'
  | 'DECIMAL'
  | 'INTEGER'
  | 'BOOLEAN'
  | 'UTC_TIMESTAMP'

export type V4TemplateValue =
  | null
  | boolean
  | string
  | number
  | V4TemplateValue[]
  | { [key: string]: V4TemplateValue }
  | { $var: string }
  | {
      $object: {
        mode: 'ALLOW_EXTRA'
        fields: Record<string, V4TemplateValue>
      }
    }

export type V4VariableDeclaration = {
  name: string
  scalarType: V4ScalarType
  source:
    | { kind: 'SESSION'; field: 'periodStart' | 'periodEnd' | 'periodKey' }
    | { kind: 'BOUND_ACCOUNT'; bindingKey: string }
    | {
        kind: 'CAPTURED_REQUEST'
        location: 'QUERY' | 'BODY_JSON' | 'BODY_FORM'
        selector: string
      }
  constraints?: {
    minLength?: number
    maxLength?: number
    pattern?: 'ACCOUNT_ID' | 'EVM_ADDRESS' | 'ISO_DATE' | 'DECIMAL'
  }
}

export type V4ResolvedVariable = {
  type: V4ScalarType
  value: string | boolean
}

export type V4Predicate =
  | { op: 'ALL' | 'ANY'; predicates: V4Predicate[] }
  | { op: 'EXISTS'; path: string }
  | {
      op: 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE' | 'IN'
      path: string
      value:
        | null
        | boolean
        | string
        | number
        | { $var: string }
        | (null | boolean | string | number | { $var: string })[]
    }

export type V4ScalarPredicate = {
  op: 'EQ' | 'NE' | 'GT' | 'GTE' | 'LT' | 'LTE'
  value: null | boolean | string | number | { $var: string }
  unit?: string
}

export type V4Pipeline = {
  output: string
  sourcePath: string
  filter?: V4Predicate
  orderBy?: { path: string; direction: 'ASC' | 'DESC' }
  groupBy?: { path: string; interval: 'UTC_DAY' }
  valuePath?: string
  cast: V4ScalarType
  reduce?:
    | 'SUM'
    | 'COUNT'
    | 'DISTINCT_COUNT'
    | 'MIN'
    | 'MAX'
    | 'AVG'
    | 'FIRST'
    | 'LAST'
    | 'LAST_MINUS_FIRST'
  postFilter?: V4ScalarPredicate
  finalReduce?: 'COUNT' | 'SUM' | 'MIN' | 'MAX' | 'AVG'
  valueUnit?: string
  outputUnit?: string
}

export type V4Connector = {
  interpreter_version: 4
  connector_id: string
  revision: 1
  disabled: false
  expires_at: string
  page_origin: string
  origin: string
  request: {
    method: 'GET' | 'POST'
    matcher: {
      path: { kind: 'exact'; value: string }
      query: {
        required: Record<string, V4TemplateValue>
        optional: Record<string, never>
        capture: Record<string, never>
      }
      resource_types: ['main_frame', 'xmlhttprequest', 'fetch']
    }
    body?: V4TemplateValue
    content_type?: 'application/json'
    replay: 'EXACT_CAPTURE'
    semantics: 'READ_ONLY_QUERY'
    secret_headers: []
    max_sent_data: 8192
    max_recv_data: number
  }
  variables: V4VariableDeclaration[]
  resolved_variables: Record<string, V4ResolvedVariable>
  response_format: 'json'
  response_status: 200
  response_content_encoding?: 'gzip'
  max_decoded_data?: number
  disclosure: {
    key_paths: string[]
    scalar_paths: string[]
    collection_paths: string[]
    max_elements: 200
  }
  pipelines: V4Pipeline[]
  verifier_profile_id: string
} & (
  | {
      purpose: 'ACCOUNT_BINDING'
      account_binding: {
        providerKey: string
        accountVariable: string
        walletOutput: string
        addressType: 'EVM'
      }
    }
  | { purpose: 'METRIC'; account_binding?: never }
)

export type CapturedConnector = V2Connector | V3Connector
export type Connector = V1Connector | CapturedConnector | V4Connector

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

export function publicDnsHost(hostname: string): boolean {
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

const V4_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/
const V4_SECRET_KEY =
  /^(?:authorization|cookie|set-cookie|password|passwd|secret|token|access[_-]?token|api[_-]?key)$/i
const V4_SCALAR_TYPES = new Set<V4ScalarType>([
  'STRING',
  'DECIMAL',
  'INTEGER',
  'BOOLEAN',
  'UTC_TIMESTAMP',
])
const V4_COUNT_UNITS = new Set(['count', 'days', 'items'])
const V4_DECIMAL_SCALE = 100_000_000n
const V4_DECIMAL_MAX_SCALED = 99_999_999_999_999_999_999n

type V4Record = Record<string, unknown>
type V4PathSegment =
  | { kind: 'FIELD'; key: string }
  | { kind: 'INDEX'; index: number }
  | { kind: 'COLLECTION' }

function v4PlainData(
  value: unknown,
  budget = { nodes: 0, bytes: 0 },
  seen = new Set<object>(),
  depth = 0,
): void {
  if (depth > 12) fail('V4 connector is invalid.')
  budget.nodes += 1
  budget.bytes += 1
  if (budget.nodes > 4096 || budget.bytes > 65_536)
    fail('V4 connector is invalid.')
  if (value === null) {
    budget.bytes += 3
    return
  }
  if (typeof value === 'string') {
    budget.bytes += bytes(value)
    if (budget.bytes > 65_536) fail('V4 connector is invalid.')
    return
  }
  if (typeof value === 'boolean' || typeof value === 'number') {
    budget.bytes += 8
    if (budget.bytes > 65_536) fail('V4 connector is invalid.')
    return
  }
  if (typeof value !== 'object' || seen.has(value))
    fail('V4 connector is invalid.')
  const array = Array.isArray(value)
  const prototype = Object.getPrototypeOf(value)
  if (
    (array && prototype !== Array.prototype) ||
    (!array && prototype !== Object.prototype && prototype !== null)
  )
    fail('V4 connector is invalid.')
  seen.add(value)
  const input = value as Record<string, unknown>
  for (const key in input)
    if (!Object.hasOwn(input, key)) fail('V4 connector is invalid.')
  const ownKeys = Reflect.ownKeys(value)
  const expected = Object.keys(input)
  if (ownKeys.length !== expected.length + (array ? 1 : 0))
    fail('V4 connector is invalid.')
  if (array && expected.length !== value.length)
    fail('V4 connector is invalid.')
  for (const key of expected) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (!descriptor?.enumerable || !('value' in descriptor))
      fail('V4 connector is invalid.')
    budget.bytes += bytes(key)
    v4PlainData(descriptor.value, budget, seen, depth + 1)
  }
}

function v4DeepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Reflect.ownKeys(value))
      v4DeepFreeze((value as Record<PropertyKey, unknown>)[key])
    if (!Object.isFrozen(value)) Object.freeze(value)
  }
  return value
}

function v4Record(value: unknown, name: string): V4Record {
  object(value, name)
  return value
}

function v4Fields(
  value: unknown,
  allowed: readonly string[],
  requiredFields: readonly string[],
  name: string,
): V4Record {
  const input = v4Record(value, name)
  const allowedSet = new Set(allowed)
  if (
    Object.keys(input).some((key) => !allowedSet.has(key)) ||
    requiredFields.some((key) => !Object.hasOwn(input, key))
  )
    fail(`${name} is invalid.`)
  return input
}

function v4Exact(
  value: unknown,
  fields: readonly string[],
  name: string,
): V4Record {
  const input = v4Fields(value, fields, fields, name)
  if (Object.keys(input).length !== fields.length) fail(`${name} is invalid.`)
  return input
}

function v4UnsafeString(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (
      code <= 0x1f ||
      (code >= 0x7f && code <= 0x9f) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    )
      return true
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (next < 0xdc00 || next > 0xdfff) return true
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) return true
  }
  return false
}

function v4String(
  value: unknown,
  name: string,
  max = 1024,
  allowEmpty = true,
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    bytes(value) > max ||
    v4UnsafeString(value)
  )
    fail(`${name} is invalid.`)
  return value
}

function v4Identifier(value: unknown, name: string): string {
  const result = v4String(value, name, 128, false)
  if (!V4_IDENTIFIER.test(result)) fail(`${name} is invalid.`)
  return result
}

function v4Token(value: unknown, name: string): string {
  const result = v4String(value, name, 128, false)
  if (!/^[A-Za-z0-9_-]+$/.test(result)) fail(`${name} is invalid.`)
  return result
}

function v4Ipv4(value: string): number | null {
  const parts = value.split('.')
  if (
    parts.length !== 4 ||
    parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)
  )
    return null
  return parts.reduce((result, part) => result * 256 + Number(part), 0)
}

function v4Ipv4InCidr(value: number, base: string, prefix: number): boolean {
  const baseValue = v4Ipv4(base)
  if (baseValue === null) return false
  const size = 2 ** (32 - prefix)
  return Math.floor(value / size) === Math.floor(baseValue / size)
}

function v4Ipv6(value: string): bigint | null {
  const halves = value.toLowerCase().split('::')
  if (halves.length > 2) return null
  const parseHalf = (half: string): number[] | null => {
    if (!half) return []
    const parts = half.split(':')
    const result: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      result.push(Number.parseInt(part, 16))
    }
    return result
  }
  const left = parseHalf(halves[0] ?? '')
  const right = parseHalf(halves[1] ?? '')
  if (!left || !right) return null
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => 0),
    ...right,
  ]
  if (groups.length !== 8) return null
  return groups.reduce((result, group) => (result << 16n) | BigInt(group), 0n)
}

function v4Ipv6InCidr(value: bigint, base: string, prefix: number): boolean {
  const baseValue = v4Ipv6(base)
  if (baseValue === null) return false
  const shift = BigInt(128 - prefix)
  return value >> shift === baseValue >> shift
}

function v4PublicHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const ipv4 = v4Ipv4(normalized)
  if (ipv4 !== null) {
    return ![
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.88.99.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, prefix]) =>
      v4Ipv4InCidr(ipv4, base as string, prefix as number),
    )
  }
  const ipv6 = v4Ipv6(normalized)
  if (ipv6 !== null) {
    return (
      v4Ipv6InCidr(ipv6, '2000::', 3) &&
      ![
        ['2001::', 23],
        ['2001:db8::', 32],
        ['2002::', 16],
        ['3fff::', 20],
      ].some(([base, prefix]) =>
        v4Ipv6InCidr(ipv6, base as string, prefix as number),
      )
    )
  }
  const dns = normalized.replace(/\.$/, '')
  return (
    dns.includes('.') &&
    ![
      'home',
      'home.arpa',
      'internal',
      'invalid',
      'lan',
      'local',
      'localdomain',
      'localhost',
      'test',
    ].some((suffix) => dns === suffix || dns.endsWith(`.${suffix}`))
  )
}

function v4Origin(value: unknown, name: string): string {
  const result = v4String(value, name, 2048, false)
  let url: URL
  try {
    url = new URL(result)
  } catch {
    fail(`${name} must be a public HTTPS origin.`)
  }
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.origin !== result ||
    url.hostname.includes('*') ||
    !publicDnsHost(url.hostname) ||
    !v4PublicHostname(url.hostname)
  )
    fail(`${name} must be an exact HTTPS origin.`)
  return result
}

function v4Path(value: unknown): string {
  const result = v4String(value, 'request.matcher.path.value', 512, false)
  if (
    !result.startsWith('/') ||
    result.startsWith('//') ||
    result.includes('\\') ||
    result.includes('?') ||
    result.includes('#') ||
    /\s/.test(result) ||
    /%(?:2e|2f|5c|3f|23|25|0[0-9a-f]|1[0-9a-f]|7f)/i.test(result)
  )
    fail('request.matcher.path.value is invalid.')
  try {
    const parsed = new URL(result, 'https://target.invalid')
    if (
      parsed.pathname !== result ||
      parsed.search ||
      parsed.hash ||
      encodeURI(decodeURI(result)) !== result
    )
      fail('request.matcher.path.value is invalid.')
  } catch {
    fail('request.matcher.path.value is invalid.')
  }
  return result
}

function v4JsonPath(value: unknown): V4PathSegment[] {
  const path = v4String(value, 'JSONPath', 256, false)
  if (!path.startsWith('$')) fail('JSONPath is invalid.')
  const segments: V4PathSegment[] = []
  let offset = 1
  let collections = 0
  while (offset < path.length) {
    if (segments.length >= 24) fail('JSONPath is invalid.')
    if (path[offset] === '.') {
      const match = /^[A-Za-z_][A-Za-z0-9_-]*/.exec(path.slice(offset + 1))
      if (!match) fail('JSONPath is invalid.')
      if (['__proto__', 'constructor', 'prototype'].includes(match[0]))
        fail('JSONPath is invalid.')
      segments.push({ kind: 'FIELD', key: match[0] })
      offset += match[0].length + 1
      continue
    }
    if (path[offset] !== '[') fail('JSONPath is invalid.')
    if (path.startsWith('[*]', offset)) {
      collections += 1
      if (collections > 1) fail('JSONPath is invalid.')
      segments.push({ kind: 'COLLECTION' })
      offset += 3
      continue
    }
    const index = /^\[(0|[1-9]\d*)\]/.exec(path.slice(offset))
    if (index) {
      const number = Number(index[1])
      if (!Number.isSafeInteger(number) || number >= 200)
        fail('JSONPath is invalid.')
      segments.push({ kind: 'INDEX', index: number })
      offset += index[0].length
      continue
    }
    const quote = path[offset + 1]
    if (quote !== '"' && quote !== "'") fail('JSONPath is invalid.')
    const close = path.indexOf(`${quote}]`, offset + 2)
    if (close < 0) fail('JSONPath is invalid.')
    const key = path.slice(offset + 2, close)
    if (
      !key ||
      bytes(key) > 128 ||
      key.includes('"') ||
      key.includes("'") ||
      key.includes('\\') ||
      v4UnsafeString(key) ||
      ['__proto__', 'constructor', 'prototype'].includes(key)
    )
      fail('JSONPath is invalid.')
    segments.push({ kind: 'FIELD', key })
    offset = close + 2
  }
  return segments
}

function v4CanonicalPath(segments: readonly V4PathSegment[]): string {
  let path = '$'
  for (const segment of segments) {
    if (segment.kind === 'COLLECTION') path += '[*]'
    else if (segment.kind === 'INDEX') path += `[${segment.index}]`
    else if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(segment.key))
      path += `.${segment.key}`
    else path += `[${JSON.stringify(segment.key)}]`
  }
  return path
}

function v4Scalar(value: unknown, name: string): void {
  if (value === null || typeof value === 'boolean') return
  if (typeof value === 'string') {
    v4String(value, name)
    return
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return
  fail(`${name} is invalid.`)
}

function v4Template(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
  depth = 1,
): void {
  if (depth > 12) fail('request template is invalid.')
  if (value === null || typeof value !== 'object') {
    v4Scalar(value, 'request template scalar')
    return
  }
  if (Array.isArray(value)) {
    if (value.length > 200) fail('request template is invalid.')
    for (const item of value) v4Template(item, variables, references, depth + 1)
    return
  }
  const input = v4Record(value, 'request template')
  if (Object.hasOwn(input, '$var')) {
    v4Exact(input, ['$var'], 'request template variable')
    const name = v4Identifier(input.$var, 'request template variable')
    if (!variables.has(name)) fail('request template variable is invalid.')
    references.set(name, (references.get(name) ?? 0) + 1)
    return
  }
  if (Object.hasOwn(input, '$object')) {
    fail('request template must match every request field exactly.')
  }
  v4TemplateObject(input, variables, references, depth)
}

function v4TemplateObject(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
  depth: number,
): void {
  const input = v4Record(value, 'request template object')
  const names = Object.keys(input)
  if (names.length > 200) fail('request template object is invalid.')
  for (const name of names) {
    v4String(name, 'request template key', 128, false)
    if (name === '$var' || name === '$object' || V4_SECRET_KEY.test(name))
      fail('request template key is invalid.')
    v4Template(input[name], variables, references, depth + 1)
  }
}

function v4Decimal(value: unknown): boolean {
  const lexeme =
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    !Object.is(value, -0)
      ? String(value)
      : typeof value === 'string'
        ? value
        : null
  if (!lexeme || !/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(lexeme)) return false
  if (/^-0(?:\.0+)?$/.test(lexeme)) return false
  const unsigned = lexeme.startsWith('-') ? lexeme.slice(1) : lexeme
  const [whole, fraction = ''] = unsigned.split('.')
  if (fraction.length > 8) return false
  const magnitude =
    BigInt(whole) * V4_DECIMAL_SCALE + BigInt(fraction.padEnd(8, '0'))
  const scaled = lexeme.startsWith('-') ? -magnitude : magnitude
  return scaled >= -V4_DECIMAL_MAX_SCALED && scaled <= V4_DECIMAL_MAX_SCALED
}

function v4IsoTimestamp(value: string): boolean {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/.exec(
      value,
    )
  if (!match) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const hour = Number(match[4])
  const minute = Number(match[5])
  const second = Number(match[6])
  const offsetHour = match[8] === undefined ? 0 : Number(match[8])
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9])
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > (days[month - 1] ?? 0) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return false
  return Number.isFinite(Date.parse(value))
}

function v4Date(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  )
}

function v4Variables(
  value: unknown,
  purpose: unknown,
): Map<string, V4VariableDeclaration> {
  if (!Array.isArray(value) || value.length > 32)
    fail('connector.variables is invalid.')
  const result = new Map<string, V4VariableDeclaration>()
  let previous = ''
  for (const item of value) {
    const input = v4Fields(
      item,
      ['name', 'scalarType', 'source', 'constraints'],
      ['name', 'scalarType', 'source'],
      'connector variable',
    )
    const name = v4Identifier(input.name, 'connector variable name')
    if (result.has(name) || (previous && previous >= name))
      fail('connector.variables is invalid.')
    previous = name
    if (!V4_SCALAR_TYPES.has(input.scalarType as V4ScalarType))
      fail('connector variable type is invalid.')
    const scalarType = input.scalarType as V4ScalarType
    const source = v4Record(input.source, 'connector variable source')
    let typedSource: V4VariableDeclaration['source']
    if (source.kind === 'SESSION') {
      v4Exact(source, ['kind', 'field'], 'connector variable source')
      if (
        source.field !== 'periodStart' &&
        source.field !== 'periodEnd' &&
        source.field !== 'periodKey'
      )
        fail('connector variable source is invalid.')
      if (
        (source.field === 'periodKey' && scalarType !== 'STRING') ||
        (source.field !== 'periodKey' && scalarType !== 'UTC_TIMESTAMP')
      )
        fail('connector variable type is invalid.')
      typedSource = {
        kind: 'SESSION',
        field: source.field,
      }
    } else if (source.kind === 'BOUND_ACCOUNT') {
      v4Exact(source, ['kind', 'bindingKey'], 'connector variable source')
      typedSource = {
        kind: 'BOUND_ACCOUNT',
        bindingKey: v4Identifier(
          source.bindingKey,
          'connector variable bindingKey',
        ),
      }
    } else if (source.kind === 'CAPTURED_REQUEST') {
      v4Exact(
        source,
        ['kind', 'location', 'selector'],
        'connector variable source',
      )
      if (
        purpose !== 'ACCOUNT_BINDING' ||
        (source.location !== 'QUERY' &&
          source.location !== 'BODY_JSON' &&
          source.location !== 'BODY_FORM')
      )
        fail('connector variable source is invalid.')
      const selector = v4String(
        source.selector,
        'connector variable selector',
        source.location === 'BODY_JSON' ? 256 : 128,
        false,
      )
      if (source.location === 'BODY_JSON') v4JsonPath(selector)
      typedSource = {
        kind: 'CAPTURED_REQUEST',
        location: source.location,
        selector,
      }
    } else fail('connector variable source is invalid.')

    let constraints: V4VariableDeclaration['constraints']
    if (input.constraints !== undefined) {
      const candidate = v4Fields(
        input.constraints,
        ['minLength', 'maxLength', 'pattern'],
        [],
        'connector variable constraints',
      )
      for (const key of ['minLength', 'maxLength'] as const) {
        const number = candidate[key]
        if (
          number !== undefined &&
          (!Number.isInteger(number) ||
            (number as number) < 0 ||
            (number as number) > 1024)
        )
          fail('connector variable constraints are invalid.')
      }
      if (
        candidate.minLength !== undefined &&
        candidate.maxLength !== undefined &&
        (candidate.minLength as number) > (candidate.maxLength as number)
      )
        fail('connector variable constraints are invalid.')
      if (
        candidate.pattern !== undefined &&
        candidate.pattern !== 'ACCOUNT_ID' &&
        candidate.pattern !== 'EVM_ADDRESS' &&
        candidate.pattern !== 'ISO_DATE' &&
        candidate.pattern !== 'DECIMAL'
      )
        fail('connector variable constraints are invalid.')
      constraints = candidate as V4VariableDeclaration['constraints']
    }
    result.set(name, {
      name,
      scalarType,
      source: typedSource,
      ...(constraints ? { constraints } : {}),
    })
  }
  return result
}

function v4ResolvedValue(
  declaration: V4VariableDeclaration,
  value: unknown,
): V4ResolvedVariable {
  const input = v4Exact(value, ['type', 'value'], 'resolved variable')
  if (input.type !== declaration.scalarType)
    fail('resolved variable type is invalid.')
  if (declaration.scalarType === 'BOOLEAN') {
    if (typeof input.value !== 'boolean' || declaration.constraints)
      fail('resolved variable value is invalid.')
  } else {
    const result = v4String(input.value, 'resolved variable value')
    const length = [...result].length
    const constraints = declaration.constraints
    if (
      (constraints?.minLength !== undefined &&
        length < constraints.minLength) ||
      (constraints?.maxLength !== undefined && length > constraints.maxLength)
    )
      fail('resolved variable value is invalid.')
    if (
      (declaration.scalarType === 'DECIMAL' && !v4Decimal(result)) ||
      (declaration.scalarType === 'INTEGER' &&
        !/^-?(?:0|[1-9]\d*)$/.test(result)) ||
      (declaration.scalarType === 'UTC_TIMESTAMP' && !v4IsoTimestamp(result))
    )
      fail('resolved variable value is invalid.')
    if (
      (constraints?.pattern === 'ACCOUNT_ID' &&
        !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(result)) ||
      (constraints?.pattern === 'EVM_ADDRESS' &&
        !/^0x[0-9A-Fa-f]{40}$/.test(result)) ||
      (constraints?.pattern === 'ISO_DATE' && !v4Date(result)) ||
      (constraints?.pattern === 'DECIMAL' && !v4Decimal(result))
    )
      fail('resolved variable value is invalid.')
  }
  return input as V4ResolvedVariable
}

function v4ResolvedVariables(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
): void {
  const input = v4Record(value, 'connector.resolved_variables')
  const expected = [...variables.values()].filter(
    (item) => item.source.kind !== 'CAPTURED_REQUEST',
  )
  const expectedNames = expected.map((item) => item.name).sort()
  const names = Object.keys(input).sort()
  if (
    names.length !== expectedNames.length ||
    names.some((name, index) => name !== expectedNames[index])
  )
    fail('connector.resolved_variables is invalid.')
  const semanticSources = new Map<string, V4ResolvedVariable>()
  for (const declaration of expected) {
    const resolved = v4ResolvedValue(declaration, input[declaration.name])
    const source = declaration.source
    if (source.kind === 'CAPTURED_REQUEST')
      fail('connector.resolved_variables is invalid.')
    const sourceKey =
      source.kind === 'SESSION'
        ? `SESSION:${source.field}`
        : `BOUND_ACCOUNT:${source.bindingKey}`
    const previous = semanticSources.get(sourceKey)
    if (
      previous &&
      (previous.type !== resolved.type || previous.value !== resolved.value)
    )
      fail('connector.resolved_variables is invalid.')
    semanticSources.set(sourceKey, resolved)
  }
}

function v4VariableReference(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
): void {
  const input = v4Exact(value, ['$var'], 'pipeline variable')
  const name = v4Identifier(input.$var, 'pipeline variable')
  const declaration = variables.get(name)
  if (!declaration || declaration.source.kind === 'CAPTURED_REQUEST')
    fail('pipeline variable is invalid.')
  references.set(name, (references.get(name) ?? 0) + 1)
}

function v4Operand(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
): void {
  if (value !== null && typeof value === 'object') {
    v4VariableReference(value, variables, references)
    return
  }
  v4Scalar(value, 'pipeline operand')
}

function v4OperandType(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
): { type: V4ScalarType; variable: boolean } {
  if (value !== null && typeof value === 'object') {
    const input = v4Exact(value, ['$var'], 'pipeline variable')
    const name = v4Identifier(input.$var, 'pipeline variable')
    const declaration = variables.get(name)
    if (!declaration || declaration.source.kind === 'CAPTURED_REQUEST')
      fail('pipeline variable is invalid.')
    references.set(name, (references.get(name) ?? 0) + 1)
    return { type: declaration.scalarType, variable: true }
  }
  v4Scalar(value, 'pipeline operand')
  return {
    type:
      typeof value === 'boolean'
        ? 'BOOLEAN'
        : typeof value === 'number'
          ? 'INTEGER'
          : 'STRING',
    variable: false,
  }
}

function v4Predicate(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
  state: { leaves: number },
  depth = 1,
): void {
  if (depth > 4) fail('pipeline predicate is invalid.')
  const input = v4Record(value, 'pipeline predicate')
  if (input.op === 'ALL' || input.op === 'ANY') {
    v4Exact(input, ['op', 'predicates'], 'pipeline predicate')
    if (!Array.isArray(input.predicates) || input.predicates.length === 0)
      fail('pipeline predicate is invalid.')
    for (const child of input.predicates)
      v4Predicate(child, variables, references, state, depth + 1)
    return
  }
  state.leaves += 1
  if (state.leaves > 32) fail('pipeline predicate is invalid.')
  if (input.op === 'EXISTS') {
    v4Exact(input, ['op', 'path'], 'pipeline predicate')
    v4JsonPath(input.path)
    return
  }
  if (
    !['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'IN'].includes(input.op as string)
  )
    fail('pipeline predicate is invalid.')
  v4Exact(input, ['op', 'path', 'value'], 'pipeline predicate')
  v4JsonPath(input.path)
  if (input.op === 'IN') {
    if (
      !Array.isArray(input.value) ||
      input.value.length < 1 ||
      input.value.length > 32
    )
      fail('pipeline predicate is invalid.')
    for (const item of input.value) v4Operand(item, variables, references)
  } else {
    if (Array.isArray(input.value)) fail('pipeline predicate is invalid.')
    v4Operand(input.value, variables, references)
  }
}

function v4Unit(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : v4String(value, name, 32, false)
}

function v4ReducerType(reducer: string, input: V4ScalarType): V4ScalarType {
  if (reducer === 'COUNT' || reducer === 'DISTINCT_COUNT') return 'INTEGER'
  if (reducer === 'AVG') return 'DECIMAL'
  return input
}

function v4ReducerSupports(reducer: string, input: V4ScalarType): boolean {
  if (['COUNT', 'DISTINCT_COUNT', 'FIRST', 'LAST'].includes(reducer))
    return true
  if (reducer === 'MIN' || reducer === 'MAX') return input !== 'BOOLEAN'
  return input === 'DECIMAL' || input === 'INTEGER'
}

function v4Pipelines(
  value: unknown,
  variables: ReadonlyMap<string, V4VariableDeclaration>,
  references: Map<string, number>,
): V4Pipeline[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20)
    fail('connector.pipelines is invalid.')
  const result = value as V4Pipeline[]
  let previous = ''
  for (const item of result) {
    const input = v4Fields(
      item,
      [
        'output',
        'sourcePath',
        'filter',
        'orderBy',
        'groupBy',
        'valuePath',
        'cast',
        'reduce',
        'postFilter',
        'finalReduce',
        'valueUnit',
        'outputUnit',
      ],
      ['output', 'sourcePath', 'cast'],
      'pipeline',
    )
    const output = v4Identifier(input.output, 'pipeline.output')
    if (previous && previous >= output) fail('connector.pipelines is invalid.')
    previous = output
    if (!V4_SCALAR_TYPES.has(input.cast as V4ScalarType))
      fail('pipeline.cast is invalid.')
    const cast = input.cast as V4ScalarType
    const source = v4JsonPath(input.sourcePath)
    const collection = source.some((segment) => segment.kind === 'COLLECTION')
    const reduce = input.reduce as string | undefined
    const finalReduce = input.finalReduce as string | undefined
    if (
      reduce !== undefined &&
      ![
        'SUM',
        'COUNT',
        'DISTINCT_COUNT',
        'MIN',
        'MAX',
        'AVG',
        'FIRST',
        'LAST',
        'LAST_MINUS_FIRST',
      ].includes(reduce)
    )
      fail('pipeline.reduce is invalid.')
    if (
      finalReduce !== undefined &&
      !['COUNT', 'SUM', 'MIN', 'MAX', 'AVG'].includes(finalReduce)
    )
      fail('pipeline.finalReduce is invalid.')
    if (
      ((input.filter !== undefined ||
        input.orderBy !== undefined ||
        input.groupBy !== undefined ||
        reduce !== undefined) &&
        !collection) ||
      (collection && reduce === undefined) ||
      (input.groupBy !== undefined && reduce === undefined) ||
      (reduce !== undefined &&
        reduce !== 'COUNT' &&
        input.valuePath === undefined) ||
      (['SUM', 'AVG', 'LAST_MINUS_FIRST'].includes(reduce ?? '') &&
        cast !== 'DECIMAL' &&
        cast !== 'INTEGER') ||
      (['FIRST', 'LAST', 'LAST_MINUS_FIRST'].includes(reduce ?? '') &&
        input.orderBy === undefined)
    )
      fail('pipeline stages are invalid.')
    if (input.filter !== undefined)
      v4Predicate(input.filter, variables, references, { leaves: 0 })
    if (input.orderBy !== undefined) {
      const order = v4Exact(
        input.orderBy,
        ['path', 'direction'],
        'pipeline.orderBy',
      )
      v4JsonPath(order.path)
      if (order.direction !== 'ASC' && order.direction !== 'DESC')
        fail('pipeline.orderBy is invalid.')
    }
    if (input.groupBy !== undefined) {
      const group = v4Exact(
        input.groupBy,
        ['path', 'interval'],
        'pipeline.groupBy',
      )
      v4JsonPath(group.path)
      if (group.interval !== 'UTC_DAY') fail('pipeline.groupBy is invalid.')
    }
    if (input.valuePath !== undefined) v4JsonPath(input.valuePath)
    const valueUnit = v4Unit(input.valueUnit, 'pipeline.valueUnit')
    const outputUnit = v4Unit(input.outputUnit, 'pipeline.outputUnit')
    if (
      (finalReduce === undefined && valueUnit !== outputUnit) ||
      (finalReduce !== undefined &&
        finalReduce !== 'COUNT' &&
        valueUnit !== outputUnit) ||
      ((reduce === 'COUNT' || reduce === 'DISTINCT_COUNT') &&
        !V4_COUNT_UNITS.has(valueUnit ?? '')) ||
      (finalReduce === 'COUNT' && !V4_COUNT_UNITS.has(outputUnit ?? ''))
    )
      fail('pipeline units are invalid.')
    let stageType = cast
    let cardinality: 'SCALAR' | 'COLLECTION' = collection
      ? 'COLLECTION'
      : 'SCALAR'
    if (reduce !== undefined) {
      if (!v4ReducerSupports(reduce, stageType))
        fail('pipeline.reduce is invalid.')
      stageType = v4ReducerType(reduce, stageType)
      cardinality = input.groupBy === undefined ? 'SCALAR' : 'COLLECTION'
    }
    if (input.postFilter !== undefined) {
      if (cardinality !== 'COLLECTION' || input.groupBy === undefined)
        fail('pipeline.postFilter is invalid.')
      const predicate = v4Fields(
        input.postFilter,
        ['op', 'value', 'unit'],
        ['op', 'value'],
        'pipeline.postFilter',
      )
      if (
        !['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE'].includes(predicate.op as string)
      )
        fail('pipeline.postFilter is invalid.')
      if (
        (valueUnit === undefined && Object.hasOwn(predicate, 'unit')) ||
        (valueUnit !== undefined && predicate.unit !== valueUnit)
      )
        fail('pipeline.postFilter is invalid.')
      const operand = v4OperandType(predicate.value, variables, references)
      let operandType = operand.type
      if (stageType === 'DECIMAL' && !operand.variable) {
        if (!v4Decimal(predicate.value)) fail('pipeline.postFilter is invalid.')
        operandType = 'DECIMAL'
      } else if (stageType === 'UTC_TIMESTAMP' && !operand.variable) {
        if (
          typeof predicate.value !== 'string' ||
          !v4IsoTimestamp(predicate.value)
        )
          fail('pipeline.postFilter is invalid.')
        operandType = 'UTC_TIMESTAMP'
      }
      const numericMatch =
        !operand.variable &&
        (stageType === 'DECIMAL' || stageType === 'INTEGER') &&
        (operandType === 'DECIMAL' || operandType === 'INTEGER')
      if (
        (!numericMatch && operandType !== stageType) ||
        ((stageType === 'BOOLEAN' || stageType === 'STRING') &&
          predicate.op !== 'EQ' &&
          predicate.op !== 'NE')
      )
        fail('pipeline.postFilter is invalid.')
    }
    if (finalReduce !== undefined) {
      if (
        cardinality !== 'COLLECTION' ||
        !v4ReducerSupports(finalReduce, stageType)
      )
        fail('pipeline.finalReduce is invalid.')
      stageType = v4ReducerType(finalReduce, stageType)
      cardinality = 'SCALAR'
    }
    if (cardinality !== 'SCALAR') fail('pipeline stages are invalid.')
  }
  return result
}

function v4DisclosurePlan(pipelines: readonly V4Pipeline[]) {
  const keys = new Set<string>()
  const scalars = new Set<string>()
  const collections = new Set<string>()
  const structure = (segments: readonly V4PathSegment[]) => {
    const prefix: V4PathSegment[] = []
    for (const segment of segments) {
      if (segment.kind === 'FIELD') {
        prefix.push(segment)
        keys.add(v4CanonicalPath(prefix))
      } else {
        collections.add(v4CanonicalPath(prefix))
        prefix.push(segment)
      }
    }
  }
  const dependency = (
    source: readonly V4PathSegment[],
    path: unknown,
    scalar = true,
  ) => {
    const segments = [...source, ...v4JsonPath(path)]
    structure(segments)
    if (scalar) scalars.add(v4CanonicalPath(segments))
  }
  const predicateDependencies = (
    source: readonly V4PathSegment[],
    predicate: V4Predicate,
  ) => {
    if ('predicates' in predicate) {
      for (const child of predicate.predicates)
        predicateDependencies(source, child)
    } else dependency(source, predicate.path, predicate.op !== 'EXISTS')
  }
  for (const pipeline of pipelines) {
    const source = v4JsonPath(pipeline.sourcePath)
    structure(source)
    if (
      !source.some((segment) => segment.kind === 'COLLECTION') &&
      pipeline.valuePath === undefined
    )
      scalars.add(v4CanonicalPath(source))
    if (pipeline.filter) predicateDependencies(source, pipeline.filter)
    if (pipeline.orderBy) dependency(source, pipeline.orderBy.path)
    if (pipeline.groupBy) dependency(source, pipeline.groupBy.path)
    if (pipeline.valuePath) dependency(source, pipeline.valuePath)
  }
  return {
    key_paths: [...keys].sort(),
    scalar_paths: [...scalars].sort(),
    collection_paths: [...collections].sort(),
  }
}

function v4TemplateAtPath(
  value: unknown,
  segments: readonly V4PathSegment[],
): unknown {
  let current = value
  for (const segment of segments) {
    if (segment.kind === 'COLLECTION') return undefined
    if (segment.kind === 'INDEX') {
      if (!Array.isArray(current)) return undefined
      current = current[segment.index]
      continue
    }
    if (!current || typeof current !== 'object' || Array.isArray(current))
      return undefined
    const object = current as V4Record
    const wrapped = object.$object as V4Record | undefined
    const fields = wrapped ? (wrapped.fields as V4Record) : object
    current = fields[segment.key]
  }
  return current
}

function validateV4Connector(value: unknown): V4Connector {
  v4PlainData(value)
  try {
    structuredClone(value)
  } catch {
    fail('V4 connector is invalid.')
  }
  const initial = v4Record(value, 'connector')
  const purpose = initial.purpose
  const hasResponseContentEncoding = Object.hasOwn(
    initial,
    'response_content_encoding',
  )
  const hasMaxDecodedData = Object.hasOwn(initial, 'max_decoded_data')
  if (hasResponseContentEncoding !== hasMaxDecodedData)
    fail('V4 response encoding is invalid.')
  const fields = [
    'interpreter_version',
    'connector_id',
    'revision',
    'disabled',
    'purpose',
    ...(purpose === 'ACCOUNT_BINDING' ? ['account_binding'] : []),
    'expires_at',
    'page_origin',
    'origin',
    'request',
    'variables',
    'resolved_variables',
    'response_format',
    'response_status',
    ...(hasResponseContentEncoding
      ? ['response_content_encoding', 'max_decoded_data']
      : []),
    'disclosure',
    'pipelines',
    'verifier_profile_id',
  ]
  const input = v4Exact(initial, fields, 'connector')
  if (
    input.interpreter_version !== 4 ||
    input.revision !== 1 ||
    input.disabled !== false ||
    (purpose !== 'ACCOUNT_BINDING' && purpose !== 'METRIC') ||
    input.response_format !== 'json' ||
    input.response_status !== 200
  )
    fail('V4 connector constants are invalid.')
  if (
    hasResponseContentEncoding &&
    (input.response_content_encoding !== 'gzip' ||
      !Number.isInteger(input.max_decoded_data) ||
      (input.max_decoded_data as number) < 1 ||
      (input.max_decoded_data as number) > 65_536)
  )
    fail('V4 response encoding is invalid.')
  v4Identifier(input.connector_id, 'connector_id')
  v4String(input.expires_at, 'expires_at', 64, false)
  if (
    !Number.isFinite(Date.parse(input.expires_at as string)) ||
    new Date(input.expires_at as string).toISOString() !== input.expires_at
  )
    fail('expires_at is invalid.')
  v4Origin(input.page_origin, 'page_origin')
  v4Origin(input.origin, 'origin')
  v4Token(input.verifier_profile_id, 'verifier_profile_id')

  const variables = v4Variables(input.variables, purpose)
  const references = new Map<string, number>()
  const requestInput = v4Record(input.request, 'request')
  const method = requestInput.method
  const requestFields = [
    'method',
    'matcher',
    ...(method === 'POST' ? ['body', 'content_type'] : []),
    'replay',
    'semantics',
    'secret_headers',
    'max_sent_data',
    'max_recv_data',
  ]
  const request = v4Exact(requestInput, requestFields, 'request')
  if (method === 'POST' && request.content_type !== 'application/json')
    fail('request.content_type is invalid.')
  if (
    (method !== 'GET' && method !== 'POST') ||
    request.replay !== 'EXACT_CAPTURE' ||
    request.semantics !== 'READ_ONLY_QUERY' ||
    request.max_sent_data !== 8192 ||
    !Number.isInteger(request.max_recv_data) ||
    (request.max_recv_data as number) < 1 ||
    (request.max_recv_data as number) > 65_536 ||
    !Array.isArray(request.secret_headers) ||
    request.secret_headers.length !== 0
  )
    fail('V4 request is invalid.')
  const matcher = v4Exact(
    request.matcher,
    ['path', 'query', 'resource_types'],
    'request.matcher',
  )
  const path = v4Exact(matcher.path, ['kind', 'value'], 'request.matcher.path')
  if (path.kind !== 'exact') fail('request.matcher.path is invalid.')
  v4Path(path.value)
  const query = v4Exact(
    matcher.query,
    ['required', 'optional', 'capture'],
    'request.matcher.query',
  )
  const requiredQuery = v4Record(
    query.required,
    'request.matcher.query.required',
  )
  if (Object.keys(requiredQuery).length > 32)
    fail('request.matcher.query.required is invalid.')
  if (
    Object.keys(v4Record(query.optional, 'request.matcher.query.optional'))
      .length ||
    Object.keys(v4Record(query.capture, 'request.matcher.query.capture'))
      .length ||
    !Array.isArray(matcher.resource_types) ||
    matcher.resource_types.length !== 3 ||
    matcher.resource_types.some(
      (item, index) =>
        item !== ['main_frame', 'xmlhttprequest', 'fetch'][index],
    )
  )
    fail('request.matcher is invalid.')
  for (const [name, template] of Object.entries(requiredQuery)) {
    v4String(name, 'request query key', 128, false)
    if (V4_SECRET_KEY.test(name)) fail('request query key is invalid.')
    v4Template(template, variables, references)
  }
  if (method === 'POST') {
    v4Template(request.body, variables, references)
    if (bytes(JSON.stringify(request.body)) > 8192)
      fail('request body is too large.')
  }

  const pipelines = v4Pipelines(input.pipelines, variables, references)
  v4ResolvedVariables(input.resolved_variables, variables)
  const binding =
    purpose === 'ACCOUNT_BINDING'
      ? v4Exact(
          input.account_binding,
          ['providerKey', 'accountVariable', 'walletOutput', 'addressType'],
          'account_binding',
        )
      : undefined
  if (binding) {
    if (binding.addressType !== 'EVM') fail('account_binding is invalid.')
    v4Identifier(binding.providerKey, 'account_binding.providerKey')
    const accountVariable = v4Identifier(
      binding.accountVariable,
      'account_binding.accountVariable',
    )
    const walletOutput = v4Identifier(
      binding.walletOutput,
      'account_binding.walletOutput',
    )
    const declaration = variables.get(accountVariable)
    const walletPipelines = pipelines.filter(
      (item) => item.output === walletOutput,
    )
    const pipeline = walletPipelines[0]
    let outputType = pipeline?.cast
    if (pipeline?.reduce)
      outputType = v4ReducerType(pipeline.reduce, outputType!)
    if (pipeline?.finalReduce)
      outputType = v4ReducerType(pipeline.finalReduce, outputType!)
    if (
      declaration?.source.kind !== 'CAPTURED_REQUEST' ||
      walletPipelines.length !== 1 ||
      outputType !== 'STRING' ||
      pipeline.outputUnit !== undefined
    )
      fail('account_binding is invalid.')
  } else if (
    purpose !== 'METRIC' ||
    ![...variables.values()].some(
      (item) => item.source.kind === 'BOUND_ACCOUNT',
    )
  )
    fail('account_binding is invalid.')

  for (const declaration of variables.values()) {
    if ((references.get(declaration.name) ?? 0) === 0)
      fail('connector variable is unused.')
    if (declaration.source.kind !== 'CAPTURED_REQUEST') continue
    if ((references.get(declaration.name) ?? 0) !== 1)
      fail('captured variable is ambiguous.')
    let selected: unknown
    if (declaration.source.location === 'QUERY')
      selected = requiredQuery[declaration.source.selector]
    else if (declaration.source.location === 'BODY_FORM')
      selected = (request.body as V4Record)[declaration.source.selector]
    else
      selected = v4TemplateAtPath(
        request.body,
        v4JsonPath(declaration.source.selector),
      )
    if (
      !selected ||
      typeof selected !== 'object' ||
      Array.isArray(selected) ||
      (selected as V4Record).$var !== declaration.name ||
      Object.keys(selected as V4Record).length !== 1
    )
      fail('captured variable selector is invalid.')
    if (
      (declaration.source.location === 'BODY_JSON' &&
        request.content_type !== 'application/json') ||
      (declaration.source.location === 'BODY_FORM' &&
        request.content_type !== 'application/x-www-form-urlencoded')
    )
      fail('captured variable selector is invalid.')
  }

  const disclosure = v4Exact(
    input.disclosure,
    ['key_paths', 'scalar_paths', 'collection_paths', 'max_elements'],
    'disclosure',
  )
  const expected = v4DisclosurePlan(pipelines)
  const same = (value: unknown, expectedValue: readonly string[]) =>
    Array.isArray(value) &&
    value.length === expectedValue.length &&
    value.every((item, index) => item === expectedValue[index])
  if (
    disclosure.max_elements !== 200 ||
    !same(disclosure.key_paths, expected.key_paths) ||
    !same(disclosure.scalar_paths, expected.scalar_paths) ||
    !same(disclosure.collection_paths, expected.collection_paths)
  )
    fail('disclosure is invalid.')
  if (bytes(canonicalJson(value)) > 65_536) fail('V4 connector is too large.')
  return v4DeepFreeze(value as V4Connector)
}

export function validateConnector(value: unknown): Connector {
  object(value, 'connector')
  if (value.interpreter_version === 1) return validateV1Connector(value)
  if (value.interpreter_version === 2) return validateV2Connector(value)
  if (value.interpreter_version === 3) return validateV3Connector(value)
  if (value.interpreter_version === 4) return validateV4Connector(value)
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
