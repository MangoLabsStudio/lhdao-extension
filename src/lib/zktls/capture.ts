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

export type CapturedRequest = {
  path: string
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
  captured.resource_type = undefined
}

export type CaptureBinding = {
  tabId: number
  frameId: number
  sessionId: string
  providerId: string
  revision: number
  origin: string
  path?: string
  matcher?: RequestMatcher
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
  return { ...input, origin: origin.origin, path, matcher }
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

export class CaptureSession {
  #binding: CaptureBinding
  #requestId: string | null = null
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
      details.method !== 'GET'
    )
      return
    const path = requestPath(details.url, this.#binding.origin)
    if (path === null) return
    const slots = this.#binding.matcher
      ? matchRequest(path, details.type, this.#binding.matcher)
      : path === this.#binding.path
        ? {}
        : null
    if (slots === null) return
    if (this.#used || this.#failed || this.#captured)
      fail('capture already completed')
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
    this.#requestId = details.requestId
    this.#captured = {
      path,
      secrets,
      ...(this.#binding.matcher
        ? { slots, resource_type: details.type as ResourceType }
        : {}),
    }
  }

  completes(requestId: string): boolean {
    return this.#requestId === requestId && this.#captured !== null
  }

  reject(requestId: string, reason: string): boolean {
    const captured = this.#captured
    if (this.#requestId !== requestId || !captured) return false
    this.#failed = new Error(reason)
    clearCapturedRequest(captured)
    this.#captured = null
    return true
  }

  take(): CapturedRequest {
    if (this.#failed) throw this.#failed
    if (!this.#captured) fail('no provider request was captured')
    const captured = this.#captured
    this.#used = true
    this.#captured = null
    this.#requestId = null
    return captured
  }

  clear(): void {
    if (this.#captured) clearCapturedRequest(this.#captured)
    this.#captured = null
    this.#requestId = null
  }
}
