import type {
  V4ResolvedVariable,
  V4TemplateValue,
  V4VariableDeclaration,
} from './interpreter'
import { v4PublicRequestDetails } from './v4-disclosure'
import { matchV4Body, matchV4Value } from './v4-template'

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
const MAX_V4_SENT_DATA = 8192
const MAX_REDIRECTED_REQUESTS = 64
const V4_PUBLIC_HEADER_NAMES = new Set([
  'content-type',
  'content-length',
  'accept',
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
  'sec-ch-ua',
  'sec-ch-ua-mobile',
  'sec-ch-ua-platform',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'user-agent',
  'upgrade-insecure-requests',
])

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
  semanticCanonical?: string
  capturedVariables?: Record<string, string | boolean>
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
  captured.semanticCanonical = ''
  if (captured.capturedVariables) {
    for (const key of Object.keys(captured.capturedVariables))
      captured.capturedVariables[key] = ''
    captured.capturedVariables = Object.create(null)
  }
}

export type LegacyCaptureBinding = {
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

export type V4CaptureBinding = {
  interpreterVersion: 4
  maxSentData: 8192
  tabId: number
  frameId: number
  sessionId: string
  providerId: string
  revision: number
  pageOrigin: string
  targetOrigin: string
  method: 'GET' | 'POST'
  matcher: {
    path: { kind: 'exact'; value: string }
    query: {
      required: Record<string, V4TemplateValue>
      optional: Record<string, never>
      capture: Record<string, never>
    }
    resource_types: readonly ResourceType[]
  }
  template?: V4TemplateValue
  contentType?: 'application/json'
  variables: readonly V4VariableDeclaration[]
  resolvedVariables: Readonly<Record<string, V4ResolvedVariable>>
}

export type CaptureBinding = LegacyCaptureBinding | V4CaptureBinding

export type RequestDetails = {
  requestId: string
  tabId: number
  frameId: number
  method: string
  url: string
  type?: string
  initiator?: string
  requestHeaders?: { name: string; value?: string }[]
}

export type RedirectDetails = RequestDetails & { redirectUrl: string }

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

function exactOrigin(value: string, name: string): string {
  const origin = new URL(value)
  if (origin.href !== `${origin.origin}/`) fail(`${name} is invalid`)
  return origin.origin
}

function isV4Binding(binding: CaptureBinding): binding is V4CaptureBinding {
  return 'interpreterVersion' in binding && binding.interpreterVersion === 4
}

function v4PublicHeader(name: string): boolean {
  return V4_PUBLIC_HEADER_NAMES.has(name.toLowerCase())
}

function requireV4Initiator(
  details: RequestDetails,
  binding: V4CaptureBinding,
): void {
  if (details.initiator !== binding.pageOrigin)
    fail('captured request initiator did not match')
}

function targetsV4Redirect(
  details: RedirectDetails,
  binding: V4CaptureBinding,
): boolean {
  try {
    const target = new URL(details.redirectUrl, details.url)
    const path = requestPath(target.href, binding.targetOrigin)
    return path !== null && matchV4Request(path, details.type, binding) !== null
  } catch {
    return false
  }
}

export function createCaptureBinding(input: V4CaptureBinding): V4CaptureBinding
export function createCaptureBinding(
  input: LegacyCaptureBinding,
): LegacyCaptureBinding
export function createCaptureBinding(input: CaptureBinding): CaptureBinding
export function createCaptureBinding(input: CaptureBinding): CaptureBinding {
  if (isV4Binding(input)) {
    const pageOrigin = exactOrigin(input.pageOrigin, 'capture page origin')
    const targetOrigin = exactOrigin(
      input.targetOrigin,
      'capture target origin',
    )
    const matcher = input.matcher
    if (
      !pageOrigin.startsWith('https://') ||
      !targetOrigin.startsWith('https://') ||
      matcher.path.kind !== 'exact' ||
      input.maxSentData !== MAX_V4_SENT_DATA ||
      validateRequestMatcher({
        path: matcher.path,
        query: { required: {}, optional: {}, capture: {} },
        resource_types: matcher.resource_types,
      }).path.value !== matcher.path.value ||
      Object.keys(matcher.query.optional).length !== 0 ||
      Object.keys(matcher.query.capture).length !== 0 ||
      matcher.resource_types.length !== 3 ||
      matcher.resource_types.some(
        (type, index) =>
          type !== ['main_frame', 'xmlhttprequest', 'fetch'][index],
      )
    )
      fail('capture matcher is invalid')
    if (
      (input.method === 'POST') !==
        (input.template !== undefined && input.contentType !== undefined) ||
      (input.method !== 'GET' && input.method !== 'POST')
    )
      fail('capture body is invalid')
    if (input.method === 'POST' && input.contentType !== 'application/json')
      fail('capture content type is invalid')
    if (
      !Array.isArray(input.variables) ||
      !input.resolvedVariables ||
      typeof input.resolvedVariables !== 'object'
    )
      fail('capture variables are invalid')
    return { ...input, pageOrigin, targetOrigin }
  }
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

function mergeCapturedVariables(
  ...sources: readonly (
    | Readonly<Record<string, string | boolean>>
    | undefined
  )[]
): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = Object.create(null)
  for (const source of sources) {
    if (!source) continue
    for (const name of Object.keys(source)) {
      if (Object.hasOwn(result, name))
        fail('captured request variables are ambiguous')
      const descriptor = Object.getOwnPropertyDescriptor(source, name)
      if (!descriptor?.enumerable || !('value' in descriptor))
        fail('captured request variables are invalid')
      Object.defineProperty(result, name, {
        configurable: true,
        enumerable: true,
        value: descriptor.value,
        writable: true,
      })
    }
  }
  return result
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

function matchV4Request(
  path: string,
  type: string | undefined,
  binding: V4CaptureBinding,
): Record<string, string | boolean> | null {
  if (!type || !binding.matcher.resource_types.includes(type as ResourceType))
    return null
  let url: URL
  try {
    if (normalizePathQuery(path) !== path) return null
    url = new URL(path, 'https://capture.invalid')
  } catch {
    return null
  }
  if (url.pathname !== binding.matcher.path.value) return null
  const values = new Map<string, string>()
  for (const [name, value] of url.searchParams) {
    if (values.has(name)) return null
    values.set(name, value)
  }
  const templates = binding.matcher.query.required
  if (
    values.size !== Object.keys(templates).length ||
    [...values.keys()].some((name) => !Object.hasOwn(templates, name))
  )
    return null
  let captured: Record<string, string | boolean> = Object.create(null)
  const queryVariables = binding.variables.filter(
    (variable) =>
      variable.source.kind === 'CAPTURED_REQUEST' &&
      variable.source.location === 'QUERY',
  )
  for (const [name, template] of Object.entries(templates)) {
    const matched = matchV4Value(
      values.get(name)!,
      template,
      binding.resolvedVariables,
      queryVariables.filter(
        (variable) =>
          variable.source.kind === 'CAPTURED_REQUEST' &&
          variable.source.selector === name,
      ),
      true,
    )
    if (matched === null) return null
    captured = mergeCapturedVariables(captured, matched)
  }
  return captured
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

function joinedRawBody(
  requestBody: RequestBodyDetails['requestBody'],
): Uint8Array {
  const entries = requestBody?.raw
  if (!entries?.length || entries.some((entry) => !entry.bytes))
    fail('captured POST body is invalid')
  const length = entries.reduce(
    (total, entry) => total + entry.bytes!.byteLength,
    0,
  )
  if (length > MAX_CAPTURED_BODY_BYTES) fail('captured body exceeds its limit')
  const result = new Uint8Array(length)
  let offset = 0
  for (const entry of entries) {
    const chunk = new Uint8Array(entry.bytes!)
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export class CaptureSession {
  #binding: CaptureBinding
  #requestId: string | null = null
  #candidate: CapturedRequest | null = null
  #requestBody: RequestBodyDetails['requestBody'] | undefined
  #captured: CapturedRequest | null = null
  #failed: Error | null = null
  #redirected = new Set<string>()
  #used = false

  constructor(binding: CaptureBinding) {
    this.#binding = createCaptureBinding(binding)
  }

  observe(details: RequestDetails): void {
    if (this.#redirected.has(details.requestId)) {
      this.#fail('redirected request cannot be captured')
      throw this.#failed
    }
    const binding = this.#binding
    if (
      details.tabId !== binding.tabId ||
      details.frameId !== binding.frameId ||
      details.method !== binding.method
    )
      return
    const v4 = isV4Binding(binding)
    const path = requestPath(
      details.url,
      v4 ? binding.targetOrigin : binding.origin,
    )
    if (path === null) return
    const candidate = this.#candidate
    if (!candidate || this.#requestId !== details.requestId) {
      if (binding.method === 'POST') return
      this.observeBody(details)
    }
    const matched = this.#candidate
    if (!matched || this.#requestId !== details.requestId) return
    if (v4) requireV4Initiator(details, binding)
    if (v4 && !Array.isArray(details.requestHeaders))
      fail('captured request headers are invalid')
    if (
      v4 &&
      details.requestHeaders!.some((header) => !v4PublicHeader(header.name))
    )
      fail('captured request contains an unsupported header')
    const secrets: Partial<Record<SecretHeader, string>> = {}
    if (!v4) {
      for (const header of details.requestHeaders ?? []) {
        const name = header.name.toLowerCase() as SecretHeader
        if (!binding.secretHeaders.includes(name)) continue
        if (!header.value || secrets[name] !== undefined)
          fail('captured secret headers were invalid')
        secrets[name] = header.value
      }
      for (const name of binding.secretHeaders)
        if (!secrets[name]) fail('captured secret headers were missing')
    }
    if (binding.method === 'POST') {
      const type = contentType(details.requestHeaders)
      if (!type) fail('captured request content type is unsupported')
      if (v4) {
        if (type !== binding.contentType)
          fail('captured request content type did not match')
        const contentTypeHeaders = (details.requestHeaders ?? []).filter(
          (header) => header.name.toLowerCase() === 'content-type',
        )
        if (
          contentTypeHeaders.length !== 1 ||
          contentTypeHeaders[0]?.value !== type
        )
          fail('captured request content type did not match')
        const raw = joinedRawBody(this.#requestBody)
        const bodyVariables = binding.variables.filter(
          (variable) =>
            variable.source.kind === 'CAPTURED_REQUEST' &&
            variable.source.location !== 'QUERY',
        )
        const bodyMatch = matchV4Body(
          raw,
          type,
          binding.template!,
          binding.resolvedVariables,
          bodyVariables,
        )
        if (!bodyMatch) fail('captured request body did not match')
        const capturedVariables = mergeCapturedVariables(
          matched.capturedVariables,
          bodyMatch.captured,
        )
        const expected = binding.variables.filter(
          (variable) => variable.source.kind === 'CAPTURED_REQUEST',
        ).length
        if (Object.keys(capturedVariables).length !== expected)
          fail('captured request variables were incomplete')
        matched.body = bodyMatch.exactBody
        matched.content_type = type
        matched.semanticCanonical = bodyMatch.semanticCanonical
        matched.capturedVariables = capturedVariables
      } else {
        if (!binding.bodyMatcher)
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
          if (!this.#requestBody?.formData)
            fail('captured form body is invalid')
          body = canonicalForm(this.#requestBody.formData).body
        }
        const bodySlots = matchRequestBody(body, type, binding.bodyMatcher)
        if (bodySlots === null) fail('captured request body did not match')
        const slots = { ...(matched.slots ?? {}), ...bodySlots }
        if (
          Object.keys(slots).length !==
          Object.keys(matched.slots ?? {}).length +
            Object.keys(bodySlots).length
        )
          fail('captured request slots are ambiguous')
        matched.body = body
        matched.content_type = type
        matched.slots = slots
      }
    }
    if (v4 && binding.method === 'GET') {
      const expected = binding.variables.filter(
        (variable) => variable.source.kind === 'CAPTURED_REQUEST',
      ).length
      if (Object.keys(matched.capturedVariables ?? {}).length !== expected)
        fail('captured request variables were incomplete')
    }
    const complete = {
      ...matched,
      secrets,
    }
    if (
      v4 &&
      v4PublicRequestDetails({
        origin: binding.targetOrigin,
        method: binding.method,
        path: complete.path,
        body: complete.body,
        contentType: complete.content_type,
      }).sentByteLength > binding.maxSentData
    )
      fail('captured request exceeds the signed sent limit')
    this.#captured = complete
  }

  observeBody(details: RequestBodyDetails): void {
    if (this.#redirected.has(details.requestId)) {
      this.#fail('redirected request cannot be captured')
      throw this.#failed
    }
    const binding = this.#binding
    if (
      details.tabId !== binding.tabId ||
      details.frameId !== binding.frameId ||
      details.method !== binding.method
    )
      return
    const v4 = isV4Binding(binding)
    const path = requestPath(
      details.url,
      v4 ? binding.targetOrigin : binding.origin,
    )
    if (path === null) return
    const querySlots = v4
      ? matchV4Request(path, details.type, binding)
      : binding.matcher
        ? matchRequest(path, details.type, binding.matcher)
        : path === binding.path
          ? {}
          : null
    if (querySlots === null) return
    if (v4) requireV4Initiator(details, binding)
    if (this.#used || this.#failed || this.#candidate || this.#captured)
      fail('capture already completed')
    if (binding.method === 'POST') {
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
      ...(binding.method === 'POST' ? { method: 'POST' as const } : {}),
      ...(binding.matcher
        ? v4
          ? {
              capturedVariables: querySlots,
              resource_type: details.type as ResourceType,
            }
          : {
              slots: querySlots as Record<string, string>,
              resource_type: details.type as ResourceType,
            }
        : {}),
    }
  }

  completes(requestId: string): boolean {
    this.#redirected.delete(requestId)
    return this.#requestId === requestId && this.#captured !== null
  }

  redirect(details: RedirectDetails, reason: string): boolean {
    const binding = this.#binding
    if (!isV4Binding(binding)) return this.reject(details.requestId, reason)
    if (
      details.tabId !== binding.tabId ||
      details.frameId !== binding.frameId ||
      details.method !== binding.method ||
      details.initiator !== binding.pageOrigin
    )
      return false
    const requestId = details.requestId
    const matched =
      this.#requestId === requestId && (this.#captured || this.#candidate)
    if (!matched && !targetsV4Redirect(details, binding)) return false
    if (!this.#redirected.has(requestId)) {
      if (this.#redirected.size >= MAX_REDIRECTED_REQUESTS) {
        this.#fail('too many redirects were observed')
        return true
      }
      this.#redirected.add(requestId)
    }
    if (this.#requestId !== requestId || (!this.#captured && !this.#candidate))
      return false
    this.#fail(reason)
    return true
  }

  reject(requestId: string, reason: string): boolean {
    this.#redirected.delete(requestId)
    const captured = this.#captured
    const candidate = this.#candidate
    if (this.#requestId !== requestId || (!captured && !candidate)) return false
    this.#fail(reason)
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
    this.#redirected.clear()
    return captured
  }

  clear(): void {
    if (this.#captured) clearCapturedRequest(this.#captured)
    if (this.#candidate) clearCapturedRequest(this.#candidate)
    this.#captured = null
    this.#candidate = null
    this.#requestBody = undefined
    this.#requestId = null
    this.#redirected.clear()
  }

  #fail(reason: string): void {
    this.#failed = new Error(reason)
    if (this.#captured) clearCapturedRequest(this.#captured)
    if (this.#candidate) clearCapturedRequest(this.#candidate)
    this.#candidate = null
    this.#requestBody = undefined
    this.#captured = null
  }
}
