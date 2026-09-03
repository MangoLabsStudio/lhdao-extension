const BODY_LIMIT = 64 * 1024
const HEADER_LIMIT = 16 * 1024
const URL_LIMIT = 4096
const encoder = new TextEncoder()

type BodyState =
  | 'json'
  | 'empty'
  | 'unsupported'
  | 'oversize'
  | 'invalid'
  | 'unreadable'
type Body = { state: BodyState; bytes: number; value?: unknown }
type HeaderPairs = Array<[string, string]>

/** Untrusted, local-only input for the session manager's redaction boundary. */
export type PageApiObservation = {
  transport: 'fetch' | 'xhr'
  url: string
  method: string
  status: number
  requestHeaders: HeaderPairs
  responseHeaders: HeaderPairs
  requestBodyState: BodyState
  responseBodyState: BodyState
  /** Bytes read, capped at 65,537 for oversized text; zero when unavailable. */
  requestBodyBytes: number
  responseBodyBytes: number
  requestBody?: unknown
  responseBody?: unknown
}

export type PageApiObserverOptions = {
  onObservation: (observation: PageApiObservation) => unknown
  /** API origins may differ from the page origin. Session scope is enforced upstream. */
  acceptsUrl?: (url: string) => boolean
  onReady?: () => unknown
}

function safeCall(callback: () => unknown): void {
  try {
    void Promise.resolve(callback()).catch(() => undefined)
  } catch {}
}

function ownValue(value: unknown, key: string): unknown {
  if (value === null || typeof value !== 'object') return undefined
  return Object.getOwnPropertyDescriptor(value, key)?.value
}

function headersOf(input: unknown): HeaderPairs {
  const result: HeaderPairs = []
  let bytes = 0
  const add = (key: unknown, value: unknown) => {
    if (typeof key !== 'string' || typeof value !== 'string') return false
    if (key.length + value.length > HEADER_LIMIT) return false
    bytes += encoder.encode(key).byteLength + encoder.encode(value).byteLength
    if (bytes > HEADER_LIMIT || result.length >= 64) return false
    result.push([key.toLowerCase(), value])
    return true
  }
  try {
    if (input instanceof Headers || Array.isArray(input)) {
      for (const pair of input) {
        if (!add(pair[0], pair[1])) break
      }
    } else if (input && typeof input === 'object') {
      let count = 0
      for (const key in input) {
        if (++count > 64 || !add(key, ownValue(input, key))) break
      }
    }
  } catch {}
  return result
}

function parseBody(text: string): Body {
  if (text.length > BODY_LIMIT)
    return { state: 'oversize', bytes: BODY_LIMIT + 1 }
  const bytes = encoder.encode(text).byteLength
  if (bytes > BODY_LIMIT) return { state: 'oversize', bytes: BODY_LIMIT + 1 }
  if (!text.trim()) return { state: 'empty', bytes }
  try {
    return { state: 'json', bytes, value: JSON.parse(text) }
  } catch {
    return { state: 'invalid', bytes }
  }
}

function jsonContentType(value: string | null): boolean {
  return /^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(value ?? '')
}

/** Explicit activation only. Does not send requests, persist data or prove facts. */
export function installPageApiObserver(
  options: PageApiObserverOptions,
): () => void {
  let stopped = false
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>()
  const pending = new Map<XMLHttpRequest, () => void>()
  const originalFetch = window.fetch
  const prototype = XMLHttpRequest.prototype
  const originalOpen = prototype.open
  const originalSend = prototype.send
  const originalHeader = prototype.setRequestHeader

  const readStream = async (
    stream: ReadableStream<Uint8Array> | null,
  ): Promise<Body> => {
    if (!stream) return { state: 'empty', bytes: 0 }
    const reader = stream.getReader()
    readers.add(reader)
    let bytes = 0
    let text = ''
    const decoder = new TextDecoder()
    try {
      while (!stopped) {
        const chunk = await reader.read()
        if (chunk.done) return parseBody(text + decoder.decode())
        bytes += chunk.value.byteLength
        if (bytes > BODY_LIMIT) {
          safeCall(() => reader.cancel())
          return { state: 'oversize', bytes: BODY_LIMIT + 1 }
        }
        text += decoder.decode(chunk.value, { stream: true })
      }
      return { state: 'unreadable', bytes }
    } catch {
      return { state: 'unreadable', bytes }
    } finally {
      readers.delete(reader)
      try {
        reader.releaseLock()
      } catch {}
    }
  }

  const requestBody = async (
    body: unknown,
    request?: Request,
  ): Promise<Body> => {
    try {
      if (body === undefined && request?.body)
        return await readStream(request.clone().body)
      if (body == null) return { state: 'empty', bytes: 0 }
      if (typeof body === 'string') return parseBody(body)
      if (body instanceof Blob) {
        if (body.size > BODY_LIMIT)
          return { state: 'oversize', bytes: BODY_LIMIT + 1 }
        return parseBody(await body.text())
      }
      if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
        if (body.byteLength > BODY_LIMIT)
          return { state: 'oversize', bytes: BODY_LIMIT + 1 }
        return parseBody(new TextDecoder().decode(body))
      }
      // Do not consume page-owned ReadableStream/FormData or coerce custom objects.
      return { state: 'unsupported', bytes: 0 }
    } catch {
      return { state: 'unreadable', bytes: 0 }
    }
  }

  const metadata = (input: unknown, method: unknown) => {
    try {
      const raw =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input instanceof Request
              ? input.url
              : undefined
      if (
        !raw ||
        raw.length > URL_LIMIT ||
        typeof method !== 'string' ||
        method.length > 32
      )
        return undefined
      const url = new URL(raw, window.location.href)
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.href.length > URL_LIMIT ||
        (options.acceptsUrl && !options.acceptsUrl(url.href))
      )
        return undefined
      return { url: url.href, method: method.toUpperCase() }
    } catch {
      return undefined
    }
  }

  const emit = (
    meta: Omit<
      PageApiObservation,
      | 'requestBody'
      | 'responseBody'
      | 'requestBodyState'
      | 'responseBodyState'
      | 'requestBodyBytes'
      | 'responseBodyBytes'
    >,
    request: Body,
    response: Body,
  ) => {
    if (stopped) return
    safeCall(() =>
      options.onObservation({
        ...meta,
        requestBodyState: request.state,
        responseBodyState: response.state,
        requestBodyBytes: request.bytes,
        responseBodyBytes: response.bytes,
        ...(request.state === 'json' ? { requestBody: request.value } : {}),
        ...(response.state === 'json' ? { responseBody: response.value } : {}),
      }),
    )
  }

  const fetchWrapper: typeof fetch = function (this: Window, ...args) {
    if (stopped) return originalFetch.apply(this, args)
    const [input, init] = args
    let meta: ReturnType<typeof metadata>
    let requestHeaders: HeaderPairs = []
    let body: Promise<Body> | undefined
    try {
      const request = input instanceof Request ? input : undefined
      meta = metadata(
        input,
        ownValue(init, 'method') ?? request?.method ?? 'GET',
      )
      if (meta) {
        requestHeaders = headersOf(
          ownValue(init, 'headers') ?? request?.headers,
        )
        body = requestBody(ownValue(init, 'body'), request)
      }
    } catch {}
    const result = originalFetch.apply(this, args)
    if (meta && body) {
      const captured = meta
      const request = body
      void result
        .then(async (response) => {
          if (stopped) return
          let responseBody: Body = { state: 'unreadable', bytes: 0 }
          try {
            responseBody = jsonContentType(response.headers.get('content-type'))
              ? await readStream(response.clone().body)
              : { state: 'unsupported', bytes: 0 }
          } catch {}
          emit(
            {
              ...captured,
              transport: 'fetch',
              status: response.status,
              requestHeaders,
              responseHeaders: headersOf(response.headers),
            },
            await request,
            responseBody,
          )
        })
        .catch(() => undefined)
    }
    return result
  }

  const state = new WeakMap<
    XMLHttpRequest,
    { url: string; method: string; headers: HeaderPairs }
  >()
  const removePending = (xhr: XMLHttpRequest) => {
    const listener = pending.get(xhr)
    if (listener) {
      xhr.removeEventListener('loadend', listener)
      pending.delete(xhr)
    }
  }
  const openWrapper = function (this: XMLHttpRequest, ...args: unknown[]) {
    const result = Reflect.apply(originalOpen, this, args)
    if (stopped) return result
    try {
      removePending(this)
      state.delete(this)
      const meta = metadata(args[1], args[0])
      if (meta) state.set(this, { ...meta, headers: [] })
    } catch {}
    return result
  } as typeof originalOpen
  const headerWrapper = function (
    this: XMLHttpRequest,
    ...args: Parameters<typeof originalHeader>
  ) {
    const result = originalHeader.apply(this, args)
    if (stopped) return result
    try {
      const request = state.get(this)
      if (request) request.headers = headersOf([...request.headers, args])
    } catch {}
    return result
  }
  const sendWrapper = function (
    this: XMLHttpRequest,
    ...args: Parameters<typeof originalSend>
  ) {
    if (stopped) return originalSend.apply(this, args)
    const meta = state.get(this)
    // A second send on an active XHR must keep the first observation listener.
    if (!meta || pending.has(this)) return originalSend.apply(this, args)
    const requestHeaders = [...meta.headers]
    const body = requestBody(args[0])
    const listener = () => {
      removePending(this)
      if (stopped) return
      safeCall(async () => {
        const status = this.status
        let responseBody: Body = { state: 'unreadable', bytes: 0 }
        let responseHeaders: HeaderPairs = []
        try {
          const raw = this.getAllResponseHeaders()
          if (raw.length <= HEADER_LIMIT)
            responseHeaders = headersOf(
              raw
                .split('\r\n')
                .filter(Boolean)
                .map((line) => {
                  const at = line.indexOf(':')
                  return [line.slice(0, at), line.slice(at + 1).trim()]
                }),
            )
          if (!jsonContentType(this.getResponseHeader('content-type')))
            responseBody = { state: 'unsupported', bytes: 0 }
          else if (this.responseType === '' || this.responseType === 'text')
            responseBody = parseBody(this.responseText)
          // Parsed JSON has lost the original decoded byte count (including
          // whitespace). Never reserialize it and claim the 64 KiB cap held.
          else responseBody = { state: 'unsupported', bytes: 0 }
        } catch {}
        emit(
          {
            url: meta.url,
            method: meta.method,
            transport: 'xhr',
            status,
            requestHeaders,
            responseHeaders,
          },
          await body,
          responseBody,
        )
      })
    }
    pending.set(this, listener)
    this.addEventListener('loadend', listener)
    try {
      return originalSend.apply(this, args)
    } catch (error) {
      removePending(this)
      throw error
    }
  }

  window.fetch = fetchWrapper
  prototype.open = openWrapper
  prototype.setRequestHeader = headerWrapper
  prototype.send = sendWrapper
  const stop = () => {
    if (stopped) return
    stopped = true
    for (const xhr of pending.keys()) removePending(xhr)
    for (const reader of readers) safeCall(() => reader.cancel())
    readers.clear()
    if (window.fetch === fetchWrapper) window.fetch = originalFetch
    if (prototype.open === openWrapper) prototype.open = originalOpen
    if (prototype.setRequestHeader === headerWrapper)
      prototype.setRequestHeader = originalHeader
    if (prototype.send === sendWrapper) prototype.send = originalSend
  }
  if (options.onReady) safeCall(options.onReady)
  return stop
}
