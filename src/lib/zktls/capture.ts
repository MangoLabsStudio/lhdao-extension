export const SECRET_HEADERS = [
  'cookie',
  'authorization',
  'x-csrf-token',
  'x-xsrf-token',
] as const

export type SecretHeader = (typeof SECRET_HEADERS)[number]
export type CapturedRequest = {
  path: string
  secrets: Partial<Record<SecretHeader, string>>
}

export type CaptureBinding = {
  tabId: number
  frameId: number
  sessionId: string
  providerId: string
  revision: number
  origin: string
  path: string
  secretHeaders: SecretHeader[]
}

export type RequestDetails = {
  requestId: string
  tabId: number
  frameId: number
  method: string
  url: string
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

export function createCaptureBinding(input: CaptureBinding): CaptureBinding {
  const origin = new URL(input.origin)
  if (origin.href !== `${origin.origin}/`) fail('capture origin is invalid')
  const path = normalizePathQuery(input.path)
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
  return { ...input, origin: origin.origin, path }
}

function requestPath(url: string, origin: string): string | null {
  const target = new URL(url)
  if (target.origin !== origin || target.hash) return null
  return normalizePathQuery(`${target.pathname}${target.search}`)
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
    if (this.#used || this.#failed || this.#captured)
      fail('capture already completed')
    if (
      details.tabId !== this.#binding.tabId ||
      details.frameId !== this.#binding.frameId ||
      details.method !== 'GET'
    )
      return
    const path = requestPath(details.url, this.#binding.origin)
    if (path === null || path !== this.#binding.path)
      fail('captured request did not match the signed provider')
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
    this.#captured = { path, secrets }
  }

  completes(requestId: string): boolean {
    return this.#requestId === requestId && this.#captured !== null
  }

  reject(requestId: string, reason: string): boolean {
    if (!this.completes(requestId)) return false
    this.#failed = new Error(reason)
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
    if (this.#captured)
      for (const key of Object.keys(this.#captured.secrets) as SecretHeader[])
        this.#captured.secrets[key] = ''
    this.#captured = null
    this.#requestId = null
  }
}
