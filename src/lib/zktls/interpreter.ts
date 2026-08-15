const encoder = new TextEncoder()
const MAX_SENT_DATA = 8192
const MAX_RECV_DATA = 65536
const IDENTITY_TOKEN = '${' + 'identity}'
const ALLOWED_HEADERS: Record<string, Set<string>> = {
  accept: new Set(['application/json', 'text/fragment+html']),
  'x-requested-with': new Set(['XMLHttpRequest']),
}

export type Connector = {
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

export function validateConnector(value: unknown): Connector {
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
  return value as Connector
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

export function extractIdentity(config: Connector, entries: unknown): string {
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

export function requestTarget(config: Connector, identity: string): string {
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
  config: Connector,
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
  config: Connector,
  input: { response: string; status: number; identity: string; now: string },
): { request_target: string; status: string; marker: string; claim: string } {
  validateConnector(config)
  if (
    config.disabled ||
    Date.parse(config.expires_at) <= Date.parse(input.now) ||
    !Number.isFinite(Date.parse(input.now))
  )
    fail('connector is unavailable.')
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
