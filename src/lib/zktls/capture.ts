export const SECRET_HEADERS = [
  'cookie',
  'authorization',
  'x-csrf-token',
  'x-xsrf-token',
] as const

export type SecretHeader = (typeof SECRET_HEADERS)[number]
export const RESOURCE_TYPES = ['main_frame', 'xmlhttprequest', 'fetch'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export type RequestMatcher = {
  path: { kind: 'exact' | 'prefix'; value: string }
  query: {
    required: Record<string, string>
    optional: Record<string, string>
    capture: Record<string, string>
  }
  resource_types: readonly ResourceType[]
}

export const BODY_CONTENT_TYPES = [
  'application/json',
  'application/x-www-form-urlencoded',
] as const
export type BodyContentType = (typeof BODY_CONTENT_TYPES)[number]
const MAX_CAPTURED_BODY_BYTES = 8192

export type BodyMatcher = {
  content_type: BodyContentType
  required: Record<string, string>
  capture: Record<string, string>
}

export type CapturedRequest = {
  method?: 'GET' | 'POST'
  path: string
  body?: string
  content_type?: BodyContentType
  secrets: Partial<Record<SecretHeader, string>>
  slots?: Record<string, string>
  resource_type?: ResourceType
}

export function clearSecrets(
  secrets: Partial<Record<SecretHeader, string>>,
): void {
  for (const key of Object.keys(secrets) as SecretHeader[]) secrets[key] = ''
}

export function clearCapturedRequest(captured: CapturedRequest): void {
  clearSecrets(captured.secrets)
  captured.secrets = {}
  if (captured.slots) {
    for (const key of Object.keys(captured.slots)) captured.slots[key] = ''
    captured.slots = {}
  }
  captured.path = ''
  captured.body = ''
  captured.content_type = undefined
  captured.method = undefined
  captured.resource_type = undefined
}

export type CaptureBinding = {
  tabId: number
  frameId: number
  sessionId: string
  providerId: string
  revision: number
  origin: string
  method?: 'GET' | 'POST'
  path?: string
  matcher?: RequestMatcher
  bodyMatcher?: BodyMatcher
  secretHeaders: SecretHeader[]
}

export type RequestDetails = {
  requestId: string
  tabId: number
  frameId: number
  method: string
  url: string
  type?: string
  requestHeaders?: { name: string; value?: string }[]
}

export type RequestBodyDetails = RequestDetails & {
  requestBody?: {
    formData?: Record<string, string[]>
    raw?: { bytes?: ArrayBuffer }[]
  }
}

function fail(message: string): never {
  throw new Error(message)
}

function canonicalEncoding(value: string): boolean {
  if (!/%/.test(value)) return true
  if (/%(?![0-9A-F]{2})/.test(value)) return false
  try {
    return encodeURI(decodeURI(value)) === value
  } catch {
    return false
  }
}

export function normalizePathQuery(value: string): string {
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('#'))
    fail('capture path must be a relative path without a fragment')
  if (!canonicalEncoding(value)) fail('capture path uses noncanonical encoding')
  const url = new URL(value, 'https://capture.invalid')
  const normalized = `${url.pathname}${url.search}`
  if (
    normalized !== value ||
    url.search.slice(1) !== url.searchParams.toString()
  )
    fail('capture path is not canonical')
  const names = new Set<string>()
  for (const [name] of url.searchParams) {
    if (names.has(name)) fail('capture path has duplicate query parameters')
    names.add(name)
  }
  return normalized
}

function boundedString(value: unknown, name: string, max = 256): string {
  if (
    typeof value !== 'string' ||
    !value ||
    new TextEncoder().encode(value).length > max
  )
    fail(`${name} is invalid`)
  return value
}

function boundedPairMap(
  value: unknown,
  name: string,
  valueMax = 256,
): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${name} is invalid`)
  const result: Record<string, string> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) fail(`${name} is invalid`)
    result[key] = boundedString(item, name, valueMax)
  }
  return result
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    typeof value === 'number'
  ) {
    if (typeof value === 'number' && !Number.isFinite(value))
      fail('captured JSON body is invalid')
    return JSON.stringify(value)
  }
  if (Array.isArray(value))
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  if (!value || typeof value !== 'object') fail('captured JSON body is invalid')
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(',')}}`
}

export function validateBodyMatcher(value: unknown): BodyMatcher {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('request.body is invalid')
  const matcher = value as Record<string, unknown>
  if (
    Object.keys(matcher).some(
      (key) => !['content_type', 'required', 'capture'].includes(key),
    )
  )
    fail('request.body is invalid')
  if (
    typeof matcher.content_type !== 'string' ||
    !BODY_CONTENT_TYPES.includes(matcher.content_type as BodyContentType)
  )
    fail('request.body.content_type is invalid')
  const required = boundedPairMap(matcher.required, 'request.body.required')
  const capture = boundedPairMap(matcher.capture, 'request.body.capture', 128)
  const bodyKeys = [...Object.keys(required), ...Object.values(capture)]
  if (new Set(bodyKeys).size !== bodyKeys.length)
    fail('request.body is ambiguous')
  return {
    content_type: matcher.content_type as BodyContentType,
    required,
    capture,
  }
}

export function validateRequestMatcher(value: unknown): RequestMatcher {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('request.matcher is invalid')
  const matcher = value as Record<string, unknown>
  if (
    Object.keys(matcher).some(
      (key) => !['path', 'query', 'resource_types'].includes(key),
    )
  )
    fail('request.matcher is invalid')
  if (
    !matcher.path ||
    typeof matcher.path !== 'object' ||
    Array.isArray(matcher.path)
  )
    fail('request.matcher.path is invalid')
  const path = matcher.path as Record<string, unknown>
  if (
    Object.keys(path).some((key) => !['kind', 'value'].includes(key)) ||
    (path.kind !== 'exact' && path.kind !== 'prefix')
  )
    fail('request.matcher.path is invalid')
  const pathValue = boundedString(
    path.value,
    'request.matcher.path.value',
    2048,
  )
  const pathUrl = new URL(pathValue, 'https://capture.invalid')
  if (
    !pathValue.startsWith('/') ||
    pathValue.startsWith('//') ||
    pathUrl.search ||
    pathUrl.hash ||
    pathUrl.pathname !== pathValue
  )
    fail('request.matcher.path is invalid')
  normalizePathQuery(pathValue)
  if (
    !matcher.query ||
    typeof matcher.query !== 'object' ||
    Array.isArray(matcher.query)
  )
    fail('request.matcher.query is invalid')
  const query = matcher.query as Record<string, unknown>
  if (
    Object.keys(query).some(
      (key) => !['required', 'optional', 'capture'].includes(key),
    )
  )
    fail('request.matcher.query is invalid')
  const required = boundedPairMap(
    query.required,
    'request.matcher.query.required',
  )
  const optional = boundedPairMap(
    query.optional,
    'request.matcher.query.optional',
  )
  const capture = boundedPairMap(
    query.capture,
    'request.matcher.query.capture',
    128,
  )
  const queryKeys = [
    ...Object.keys(required),
    ...Object.keys(optional),
    ...Object.values(capture),
  ]
  if (new Set(queryKeys).size !== queryKeys.length)
    fail('request.matcher.query is ambiguous')
  if (
    !Array.isArray(matcher.resource_types) ||
    matcher.resource_types.length === 0
  )
    fail('request.matcher.resource_types is invalid')
  if (
    matcher.resource_types.some(
      (type) =>
        typeof type !== 'string' ||
        !RESOURCE_TYPES.includes(type as ResourceType),
    ) ||
    new Set(matcher.resource_types).size !== matcher.resource_types.length
  )
    fail('request.matcher.resource_types is invalid')
  return {
    path: { kind: path.kind, value: pathValue },
    query: { required, optional, capture },
    resource_types: matcher.resource_types as ResourceType[],
  }
}

export function createCaptureBinding(input: CaptureBinding): CaptureBinding {
  const origin = new URL(input.origin)
  if (origin.href !== `${origin.origin}/`) fail('capture origin is invalid')
  if ((input.path === undefined) === (input.matcher === undefined))
    fail('capture target is invalid')
  const path =
    input.path === undefined ? undefined : normalizePathQuery(input.path)
  const matcher =
    input.matcher === undefined
      ? undefined
      : validateRequestMatcher(input.matcher)
  const method = input.method ?? 'GET'
  if (method !== 'GET' && method !== 'POST') fail('capture method is invalid')
  const bodyMatcher =
    input.bodyMatcher === undefined
      ? undefined
      : validateBodyMatcher(input.bodyMatcher)
  if ((method === 'POST') !== (bodyMatcher !== undefined))
    fail('capture body is invalid')
  if (
    !Number.isInteger(input.tabId) ||
    !Number.isInteger(input.frameId) ||
    !input.sessionId ||
    !input.providerId ||
    !Number.isInteger(input.revision) ||
    input.revision < 1
  )
    fail('capture binding is invalid')
  if (
    input.secretHeaders.length === 0 ||
    input.secretHeaders.some((header) => !SECRET_HEADERS.includes(header)) ||
    new Set(input.secretHeaders).size !== input.secretHeaders.length
  )
    fail('capture secret headers are invalid')
  return { ...input, origin: origin.origin, method, path, matcher, bodyMatcher }
}

function requestPath(url: string, origin: string): string | null {
  try {
    const target = new URL(url)
    if (target.origin !== origin || target.hash) return null
    return normalizePathQuery(`${target.pathname}${target.search}`)
  } catch {
    return null
  }
}

export function matchRequest(
  path: string,
  type: string | undefined,
  matcher: RequestMatcher,
): Record<string, string> | null {
  if (!type || !matcher.resource_types.includes(type as ResourceType))
    return null
  try {
    if (normalizePathQuery(path) !== path) return null
  } catch {
    return null
  }
  const url = new URL(path, 'https://capture.invalid')
  const matchesPath =
    matcher.path.kind === 'exact'
      ? url.pathname === matcher.path.value
      : url.pathname.startsWith(matcher.path.value)
  if (!matchesPath) return null
  const values = new Map<string, string>()
  for (const [name, value] of url.searchParams) {
    if (values.has(name)) return null
    values.set(name, value)
  }
  const allowed = new Set([
    ...Object.keys(matcher.query.required),
    ...Object.keys(matcher.query.optional),
    ...Object.values(matcher.query.capture),
  ])
  if ([...values.keys()].some((name) => !allowed.has(name))) return null
  for (const [name, value] of Object.entries(matcher.query.required))
    if (values.get(name) !== value) return null
  for (const [name, value] of Object.entries(matcher.query.optional))
    if (values.has(name) && values.get(name) !== value) return null
  const slots: Record<string, string> = {}
  for (const [slot, name] of Object.entries(matcher.query.capture)) {
    const value = values.get(name)
    if (value === undefined) return null
    slots[slot] = value
  }
  return slots
}

function canonicalForm(entries: Record<string, string[]>): {
  body: string
  values: Map<string, string>
} {
  const values = new Map<string, string>()
  for (const [name, items] of Object.entries(entries)) {
    if (items.length !== 1 || values.has(name))
      fail('captured form body has duplicate fields')
    const [value] = items
    if (typeof value !== 'string') fail('captured form body is invalid')
    values.set(name, value)
  }
  const form = new URLSearchParams()
  for (const name of [...values.keys()].sort())
    form.set(name, values.get(name)!)
  const body = form.toString()
  if (new TextEncoder().encode(body).length > MAX_CAPTURED_BODY_BYTES)
    fail('captured body exceeds its limit')
  return { body, values }
}

function canonicalJsonBody(raw: BufferSource): {
  body: string
  values: Map<string, string>
} {
  if (raw.byteLength > MAX_CAPTURED_BODY_BYTES)
    fail('captured body exceeds its limit')
  let value: unknown
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
  } catch {
    fail('captured JSON body is invalid')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail('captured JSON body is invalid')
  const values = new Map<string, string>()
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string')
      fail('captured JSON body fields must be strings')
    values.set(name, item)
  }
  const body = canonicalJson(value)
  if (new TextEncoder().encode(body).length > MAX_CAPTURED_BODY_BYTES)
    fail('captured body exceeds its limit')
  return { body, values }
}

function contentType(
  headers: RequestDetails['requestHeaders'],
): BodyContentType | null {
  const header = headers?.find(
    (item) => item.name.toLowerCase() === 'content-type',
  )?.value
  const value = header?.split(';', 1)[0]?.trim().toLowerCase()
  return BODY_CONTENT_TYPES.includes(value as BodyContentType)
    ? (value as BodyContentType)
    : null
}

export function matchRequestBody(
  body: string,
  type: BodyContentType,
  matcher: BodyMatcher,
): Record<string, string> | null {
  if (type !== matcher.content_type) return null
  let values: Map<string, string>
  try {
    if (type === 'application/json') {
      const parsed = canonicalJsonBody(new TextEncoder().encode(body))
      if (parsed.body !== body) return null
      values = parsed.values
    } else {
      const form = new URLSearchParams(body)
      const entries: Record<string, string[]> = {}
      for (const [name, value] of form) {
        const values = entries[name] ?? []
        values.push(value)
        entries[name] = values
      }
      const parsed = canonicalForm(entries)
      if (parsed.body !== body) return null
      values = parsed.values
    }
  } catch {
    return null
  }
  const allowed = new Set([
    ...Object.keys(matcher.required),
    ...Object.values(matcher.capture),
  ])
  if ([...values.keys()].some((name) => !allowed.has(name))) return null
  for (const [name, value] of Object.entries(matcher.required))
    if (values.get(name) !== value) return null
  const slots: Record<string, string> = {}
  for (const [slot, name] of Object.entries(matcher.capture)) {
    const value = values.get(name)
    if (value === undefined) return null
    slots[slot] = value
  }
  return slots
}

export class CaptureSession {
  #binding: CaptureBinding
  #requestId: string | null = null
  #candidate: CapturedRequest | null = null
  #requestBody: RequestBodyDetails['requestBody'] | undefined
  #captured: CapturedRequest | null = null
  #failed: Error | null = null
  #used = false

  constructor(binding: CaptureBinding) {
    this.#binding = createCaptureBinding(binding)
  }

  observe(details: RequestDetails): void {
    if (
      details.tabId !== this.#binding.tabId ||
      details.frameId !== this.#binding.frameId ||
      details.method !== this.#binding.method
    )
      return
    const path = requestPath(details.url, this.#binding.origin)
    if (path === null) return
    const candidate = this.#candidate
    if (!candidate || this.#requestId !== details.requestId) {
      if (this.#binding.method === 'POST') return
      this.observeBody(details)
    }
    const matched = this.#candidate
    if (!matched || this.#requestId !== details.requestId) return
    const secrets: Partial<Record<SecretHeader, string>> = {}
    for (const header of details.requestHeaders ?? []) {
      const name = header.name.toLowerCase() as SecretHeader
      if (!this.#binding.secretHeaders.includes(name)) continue
      if (!header.value || secrets[name] !== undefined)
        fail('captured secret headers were invalid')
      secrets[name] = header.value
    }
    for (const name of this.#binding.secretHeaders)
      if (!secrets[name]) fail('captured secret headers were missing')
    if (this.#binding.method === 'POST') {
      const type = contentType(details.requestHeaders)
      if (!type || !this.#binding.bodyMatcher)
        fail('captured request content type is unsupported')
      let body: string
      if (type === 'application/json') {
        if (
          !this.#requestBody?.raw ||
          this.#requestBody.raw.length !== 1 ||
          !this.#requestBody.raw[0]?.bytes
        )
          fail('captured JSON body is invalid')
        body = canonicalJsonBody(this.#requestBody.raw[0].bytes).body
      } else {
        if (!this.#requestBody?.formData) fail('captured form body is invalid')
        body = canonicalForm(this.#requestBody.formData).body
      }
      const bodySlots = matchRequestBody(body, type, this.#binding.bodyMatcher)
      if (bodySlots === null) fail('captured request body did not match')
      const slots = { ...(matched.slots ?? {}), ...bodySlots }
      if (
        Object.keys(slots).length !==
        Object.keys(matched.slots ?? {}).length + Object.keys(bodySlots).length
      )
        fail('captured request slots are ambiguous')
      matched.body = body
      matched.content_type = type
      matched.slots = slots
    }
    this.#captured = {
      ...matched,
      secrets,
    }
  }

  observeBody(details: RequestBodyDetails): void {
    if (
      details.tabId !== this.#binding.tabId ||
      details.frameId !== this.#binding.frameId ||
      details.method !== this.#binding.method
    )
      return
    const path = requestPath(details.url, this.#binding.origin)
    if (path === null) return
    const querySlots = this.#binding.matcher
      ? matchRequest(path, details.type, this.#binding.matcher)
      : path === this.#binding.path
        ? {}
        : null
    if (querySlots === null) return
    if (this.#used || this.#failed || this.#candidate || this.#captured)
      fail('capture already completed')
    if (this.#binding.method === 'POST') {
      const requestBody = details.requestBody
      if (!requestBody) fail('captured POST body is invalid')
      this.#requestBody = requestBody
    } else if (details.requestBody) {
      fail('GET request body is unsupported')
    }
    this.#requestId = details.requestId
    this.#candidate = {
      path,
      secrets: {},
      ...(this.#binding.method === 'POST' ? { method: 'POST' as const } : {}),
      ...(this.#binding.matcher
        ? { slots: querySlots, resource_type: details.type as ResourceType }
        : {}),
    }
  }

  completes(requestId: string): boolean {
    return this.#requestId === requestId && this.#captured !== null
  }

  reject(requestId: string, reason: string): boolean {
    const captured = this.#captured
    const candidate = this.#candidate
    if (this.#requestId !== requestId || (!captured && !candidate)) return false
    this.#failed = new Error(reason)
    if (captured) clearCapturedRequest(captured)
    if (candidate) clearCapturedRequest(candidate)
    this.#candidate = null
    this.#requestBody = undefined
    this.#captured = null
    return true
  }

  take(): CapturedRequest {
    if (this.#failed) throw this.#failed
    if (!this.#captured) fail('no provider request was captured')
    const captured = this.#captured
    this.#used = true
    this.#captured = null
    this.#candidate = null
    this.#requestBody = undefined
    this.#requestId = null
    return captured
  }

  clear(): void {
    if (this.#captured) clearCapturedRequest(this.#captured)
    if (this.#candidate) clearCapturedRequest(this.#candidate)
    this.#captured = null
    this.#candidate = null
    this.#requestBody = undefined
    this.#requestId = null
  }
}
