import {
  type BodyState,
  byteLength,
  dynamicKey,
  dynamicValue,
  freezeCopy,
  type Json,
  jsonBody,
  observationSecrets,
  publicHeaders,
  REDACTED,
  redact,
  redactUrl,
  safeClone,
  sensitiveKey,
} from './redaction'

export const DISCOVERY_LIMITS = {
  candidates: 100,
  samplesPerCandidate: 3,
  bodyBytes: 65536,
  sessionBytes: 5 * 1024 * 1024,
} as const
export type DiscoverySample = {
  at: number
  pageOrigin: string
  triggerPath: string
  triggerPathSafe: boolean
  request: {
    method: string
    url: string
    contentType: string
    headers: Record<string, string>
    body: Json | null
    bodyState: BodyState
    bodyBytes: number
  }
  response: Json | null
  responseBodyState: BodyState
  responseBodyBytes: number
  responseHeaders: Record<string, string>
  status: number
}
export type DiscoveryCandidate = {
  candidateId: string
  method: string
  origin: string
  path: string
  queryNames: string[]
  contentType: string
  requestContentType: string
  occurrences: number
  firstSeenAt: number
  lastSeenAt: number
  samples: DiscoverySample[]
  inference: {
    requestShape: Record<string, string>
    responseShape: Record<string, string>
    dynamicFields: string[]
    stableEnums: Record<string, Json>
  }
  configurable: boolean
  unsupportedReason:
    | 'RESPONSE_NOT_JSON'
    | 'REQUEST_UNSUPPORTED'
    | 'UNSAFE_TRIGGER_PATH'
    | 'AUTH_HEADERS_UNSUPPORTED'
    | null
}
export type CandidateSnapshot = {
  candidates: DiscoveryCandidate[]
  quota: { bytes: number; limits: typeof DISCOVERY_LIMITS }
}

function fields(
  value: Json,
  prefix: string,
  result: Record<string, Json> = {},
): Record<string, Json> {
  if (Array.isArray(value)) {
    result[prefix] = []
    value.forEach((item, index) => {
      fields(item, `${prefix}[${index}]`, result)
    })
  } else if (value && typeof value === 'object') {
    result[prefix] = {}
    for (const [key, item] of Object.entries(value).sort(([a], [b]) =>
      a.localeCompare(b),
    ))
      fields(item, `${prefix}.${key}`, result)
  } else result[prefix] = value
  return result
}
function shape(input: Record<string, Json>): Record<string, string> {
  const result = new Map<string, Set<string>>()
  for (const [key, value] of Object.entries(input)) {
    const path = key.replace(/\[\d+\]/g, '[]')
    const types = result.get(path) ?? new Set<string>()
    types.add(
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
    )
    result.set(path, types)
  }
  return Object.fromEntries(
    [...result]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, types]) => [key, [...types].sort().join('|')]),
  )
}

/** All retained values are already redacted. No raw bodies, headers, or CDP IDs. */
export class CandidateStore {
  private entries = new Map<string, DiscoveryCandidate>()
  private bytes = 0

  add(input: unknown): 'added' | 'invalid' | 'quota' {
    const cloned = safeClone(input)
    if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned))
      return 'invalid'
    const raw = cloned as Record<string, unknown>
    if (
      typeof raw.method !== 'string' ||
      !/^[A-Za-z]{1,16}$/.test(raw.method) ||
      typeof raw.url !== 'string'
    )
      return 'invalid'
    const secrets = observationSecrets(raw)
    const url = redactUrl(raw.url, secrets)
    if (!url) return 'invalid'
    const method = raw.method.toUpperCase()
    const contentType =
      typeof raw.contentType === 'string' &&
      /^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(raw.contentType)
        ? 'application/json'
        : 'other'
    const requestHeaders = publicHeaders(
      redact((raw.requestHeaders ?? {}) as Json, '', secrets),
    )
    const responseHeaders = publicHeaders(
      redact((raw.responseHeaders ?? {}) as Json, '', secrets),
      true,
    )
    const requestContentType = requestHeaders['content-type'] ?? ''
    const request = jsonBody(
      Object.hasOwn(raw, 'requestBody') ? raw.requestBody : '',
      secrets,
    )
    const response =
      contentType === 'application/json'
        ? jsonBody(raw.responseBody, secrets)
        : { state: 'non-json' as const, value: null, bytes: 0 }
    const page =
      typeof raw.documentUrl === 'string'
        ? redactUrl(raw.documentUrl, secrets)
        : null
    const triggerPathSafe =
      !!page &&
      !page.url.includes(REDACTED) &&
      !page.url.includes(encodeURIComponent(REDACTED))
    const originalPage = triggerPathSafe
      ? new URL(raw.documentUrl as string)
      : null
    const requestFields = {
      ...fields(url.query, 'query'),
      ...fields(request.value, 'request'),
    }
    const responseFields = fields(response.value, 'response')
    const dynamicFields = Object.keys(requestFields).filter(
      (key) =>
        dynamicKey(key) ||
        requestFields[key] === REDACTED ||
        (typeof requestFields[key] === 'string' &&
          dynamicValue(requestFields[key] as string)),
    )
    // Conservatively keep short literals distinct: two operations must not collapse.
    const enums = Object.fromEntries(
      Object.entries(requestFields).filter(
        ([key, value]) =>
          !dynamicFields.includes(key) &&
          (typeof value === 'boolean' ||
            (typeof value === 'number' &&
              Math.abs(value) <= 1000 &&
              /\.(?:type|operation|op|action|method|mode|kind|category)$/i.test(
                key,
              )) ||
            (typeof value === 'string' && value.length <= 64)),
      ),
    )
    const requestShape = shape(requestFields)
    const responseShape = shape(responseFields)
    const authHeaders =
      !!raw.requestHeaders &&
      typeof raw.requestHeaders === 'object' &&
      Object.keys(raw.requestHeaders).some(
        (key) => key.toLowerCase() !== 'cookie' && sensitiveKey(key),
      )
    const fingerprint = JSON.stringify([
      method,
      url.origin,
      url.path,
      Object.keys(url.query),
      contentType,
      requestContentType,
      requestHeaders,
      authHeaders,
      requestShape,
      enums,
      responseShape,
      request.state,
      response.state,
    ])
    const now = Date.now()
    const existing = this.entries.get(fingerprint)
    const sample: DiscoverySample = {
      at: now,
      pageOrigin: page?.origin ?? '',
      triggerPath: originalPage
        ? originalPage.pathname + originalPage.search
        : page
          ? page.url.slice(page.origin.length)
          : '',
      triggerPathSafe,
      request: {
        method,
        url: url.url,
        contentType: requestContentType,
        headers: requestHeaders,
        body: request.value,
        bodyState: request.state,
        bodyBytes: request.bytes,
      },
      response: response.value,
      responseHeaders,
      responseBodyState: response.state,
      responseBodyBytes: response.bytes,
      status:
        typeof raw.status === 'number' && raw.status >= 0 && raw.status <= 599
          ? raw.status
          : 0,
    }
    if (existing) {
      const updated = structuredClone(existing)
      const previous = existing.samples[0]
      const previousFields = {
        ...fields(redactUrl(previous.request.url)?.query ?? {}, 'query'),
        ...fields(previous.request.body, 'request'),
      }
      for (const [key, value] of Object.entries(requestFields))
        if (
          (value === null || typeof value !== 'object') &&
          previousFields[key] !== value &&
          !updated.inference.dynamicFields.includes(key)
        )
          updated.inference.dynamicFields.push(key)
      updated.occurrences += 1
      updated.lastSeenAt = now
      if (updated.samples.length < DISCOVERY_LIMITS.samplesPerCandidate)
        updated.samples.push(sample)
      const extra =
        byteLength(JSON.stringify(updated)) -
        byteLength(JSON.stringify(existing))
      if (this.bytes + extra > DISCOVERY_LIMITS.sessionBytes) return 'quota'
      this.entries.set(fingerprint, updated)
      this.bytes += extra
      return 'added'
    }
    if (this.entries.size >= DISCOVERY_LIMITS.candidates) return 'quota'
    const unsupportedReason =
      response.state !== 'json'
        ? 'RESPONSE_NOT_JSON'
        : !['empty', 'json'].includes(request.state)
          ? 'REQUEST_UNSUPPORTED'
          : !triggerPathSafe
            ? 'UNSAFE_TRIGGER_PATH'
            : authHeaders
              ? 'AUTH_HEADERS_UNSUPPORTED'
              : null
    const candidate: DiscoveryCandidate = {
      candidateId: crypto.randomUUID(),
      method,
      origin: url.origin,
      path: url.path,
      queryNames: Object.keys(url.query),
      contentType,
      requestContentType,
      occurrences: 1,
      firstSeenAt: now,
      lastSeenAt: now,
      samples: [sample],
      inference: {
        requestShape,
        responseShape,
        dynamicFields,
        stableEnums: enums,
      },
      configurable: unsupportedReason === null,
      unsupportedReason,
    }
    const extra =
      byteLength(JSON.stringify(candidate)) + byteLength(fingerprint)
    if (this.bytes + extra > DISCOVERY_LIMITS.sessionBytes) return 'quota'
    this.entries.set(fingerprint, candidate)
    this.bytes += extra
    return 'added'
  }

  snapshot(): CandidateSnapshot {
    return freezeCopy({
      candidates: [...this.entries.values()],
      quota: { bytes: this.bytes, limits: DISCOVERY_LIMITS },
    })
  }
  clear(): void {
    this.entries.clear()
    this.bytes = 0
  }
}
