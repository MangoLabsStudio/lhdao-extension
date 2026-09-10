import {
  type CapturedRequest,
  CaptureSession,
  clearCapturedRequest,
  createCaptureBinding,
} from './capture'
import { BODY_LIMIT, byteLength, sensitiveKey } from './discovery/redaction'
import type { V4Connector } from './interpreter'

type Pending = {
  request: {
    url: string
    method: string
    postData?: string
    headers: Record<string, string>
  }
  type: string
  documentUrl: string
  headers?: Record<string, string>
  response?: {
    status: number
    mimeType: string
    headers?: Record<string, string>
  }
  bytes: number
  reading?: boolean
}
type NetworkEvent = {
  requestId?: string
  frameId?: string
  loaderId?: string
  type?: string
  documentURL?: string
  request?: Pending['request']
  headers?: Record<string, string>
  response?: Pending['response']
  redirectResponse?: object
  dataLength?: number
}
export type ReviewedCapture = {
  captured: CapturedRequest
  responseBody?: string
  contentType: string
  status: number
  responseHeaders?: Record<string, string>
  requestHeaders?: Record<string, string>
  pageUrl: string
}

/** Extension-owned, bounded observer. No navigation, replay, upload or storage. */
export async function observeProofReview(input: {
  tabId: number
  sessionId: string
  config: V4Connector
  signal: AbortSignal
  onReady(): void
}): Promise<{
  read: Promise<ReviewedCapture>
  invalidated: Promise<string>
  assertCurrent(): Promise<void>
  dispose(): Promise<void>
}> {
  const { tabId, sessionId, config, signal } = input
  const target = { tabId }
  const tab = await chrome.tabs.get(tabId)
  if (!tab.url || new URL(tab.url).origin !== config.page_origin)
    throw new Error('REVIEW_WRONG_TAB')
  if (signal.aborted) throw new Error('REVIEW_CANCELLED')
  let pageUrl = tab.url
  let frameId = ''
  let loaderId = ''
  let attached = false
  let disposed = false
  let invalid: string | null = null
  let selected: ReviewedCapture | null = null
  let readingCandidate: CapturedRequest | null = null
  let selectedCredentials: string | null = null
  let resolveRead!: (value: ReviewedCapture) => void
  let rejectRead!: (error: Error) => void
  let resolveInvalid!: (reason: string) => void
  const read = new Promise<ReviewedCapture>((resolve, reject) => {
    resolveRead = resolve
    rejectRead = reject
  })
  // Attach/setup can fail before the caller receives read.
  void read.catch(() => {})
  const invalidated = new Promise<string>((resolve) => {
    resolveInvalid = resolve
  })
  const cancellable = <T>(promise: Promise<T>) =>
    Promise.race([
      promise,
      invalidated.then((reason): never => {
        throw new Error(reason)
      }),
    ])
  const pending = new Map<string, Pending>()
  const extraHeaders = new Map<string, Record<string, string>>()
  const origin = (url: unknown) => {
    try {
      if (typeof url !== 'string') return ''
      return new URL(url).origin
    } catch {
      return ''
    }
  }
  const fail = (reason: string) => {
    if (invalid || disposed) return
    invalid = reason
    pending.clear()
    extraHeaders.clear()
    resolveInvalid(reason)
    rejectRead(new Error(reason))
  }
  const abort = () => fail('REVIEW_CANCELLED')
  const updated = (id: number, change: chrome.tabs.TabChangeInfo) => {
    if (id !== tabId) return
    if (change.url && origin(change.url) !== config.page_origin)
      fail('REVIEW_ORIGIN_CHANGED')
    else if (selected && (change.status === 'loading' || change.url))
      fail('REVIEW_PAGE_CHANGED')
  }
  const removed = (id: number) => {
    if (id === tabId) fail('REVIEW_TAB_CLOSED')
  }
  const detached = (source: chrome.debugger.Debuggee) => {
    if (source.tabId === tabId) {
      attached = false
      fail('REVIEW_DEBUGGER_DETACHED')
    }
  }
  const binding = createCaptureBinding({
    interpreterVersion: 4,
    maxSentData: config.request.max_sent_data,
    tabId,
    frameId: 0,
    sessionId,
    providerId: config.connector_id,
    revision: config.revision,
    pageOrigin: config.page_origin,
    targetOrigin: config.origin,
    method: config.request.method,
    matcher: config.request.matcher,
    ...(config.request.method === 'POST'
      ? {
          template: config.request.body,
          contentType: config.request.content_type,
        }
      : {}),
    publicHeaders: config.request.public_headers,
    variables: config.variables,
    resolvedVariables: config.resolved_variables,
  })
  const finish = async (id: string, item: Pending) => {
    if (item.reading || invalid || disposed) return
    item.reading = true
    const capture = new CaptureSession(binding)
    let value: CapturedRequest | undefined
    try {
      const headers = item.headers ?? item.request.headers
      const url = new URL(item.request.url)
      const pseudo: Record<string, string> = {
        ':method': item.request.method,
        ':authority': url.host,
        ':scheme': url.protocol.slice(0, -1),
        ':path': url.pathname + url.search,
      }
      const ordinaryHeaders = Object.entries(headers).filter(
        ([name, value]) => {
          if (!name.startsWith(':')) return true
          if (pseudo[name] !== value)
            throw new Error('REVIEW_PROTOCOL_HEADERS_INVALID')
          return false
        },
      )
      const details = {
        requestId: id,
        tabId,
        frameId: 0,
        method: item.request.method,
        url: item.request.url,
        type: item.type === 'Fetch' ? 'fetch' : 'xmlhttprequest',
        initiator: origin(item.documentUrl),
        requestHeaders: ordinaryHeaders.map(([name, value]) => ({
          name,
          value,
        })),
      }
      capture.observeBody({
        ...details,
        ...(item.request.postData !== undefined
          ? {
              requestBody: {
                raw: [
                  {
                    bytes: new TextEncoder().encode(item.request.postData)
                      .buffer,
                  },
                ],
              },
            }
          : {}),
      })
      capture.observe(details)
      if (!capture.completes(id)) return
      value = capture.take()
      const credentials = JSON.stringify(
        ordinaryHeaders
          .filter(([name]) => sensitiveKey(name))
          .map(([name, value]) => [name.toLowerCase(), value])
          .sort(([a], [b]) => a.localeCompare(b)),
      )
      const previous = selected?.captured ?? readingCandidate
      if (previous) {
        if (
          previous.path !== value.path ||
          previous.semanticCanonical !== value.semanticCanonical ||
          selectedCredentials !== credentials
        )
          fail('REVIEW_ACCOUNT_OR_REQUEST_CHANGED')
        return
      }
      readingCandidate = value
      selectedCredentials = credentials
      let responseBody: string | undefined
      if (item.bytes > BODY_LIMIT) responseBody = ' '.repeat(BODY_LIMIT + 1)
      else {
        try {
          const result = (await chrome.debugger.sendCommand(
            target,
            'Network.getResponseBody',
            { requestId: id },
          )) as { body?: string; base64Encoded?: boolean }
          if (typeof result.body === 'string') {
            if (result.body.length > Math.ceil(BODY_LIMIT / 3) * 4)
              responseBody = ' '.repeat(BODY_LIMIT + 1)
            else
              responseBody = result.base64Encoded
                ? new TextDecoder('utf-8', { fatal: true }).decode(
                    Uint8Array.from(atob(result.body), (char) =>
                      char.charCodeAt(0),
                    ),
                  )
                : result.body
            if (byteLength(responseBody) > BODY_LIMIT)
              responseBody = ' '.repeat(BODY_LIMIT + 1)
          }
        } catch {
          /* explicit unavailable response in the preview */
        }
      }
      if (invalid || disposed || pending.get(id) !== item) return
      selected = {
        captured: value,
        responseBody,
        contentType: item.response?.mimeType ?? '',
        status: item.response?.status ?? 0,
        responseHeaders: item.response?.headers,
        requestHeaders: Object.fromEntries(ordinaryHeaders),
        pageUrl,
      }
      value = undefined
      resolveRead(selected)
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === 'REVIEW_PROTOCOL_HEADERS_INVALID'
      )
        fail(error.message)
      /* Nonmatching requests are not proof candidates. */
    } finally {
      capture.clear()
      if (readingCandidate === value) readingCandidate = null
      if (value) clearCapturedRequest(value)
      pending.delete(id)
      extraHeaders.delete(id)
    }
  }
  const event = (
    source: chrome.debugger.Debuggee,
    method: string,
    raw?: object,
  ) => {
    if (source.tabId !== tabId || disposed || invalid || !raw) return
    const p = raw as NetworkEvent
    const id = p.requestId
    if (typeof id !== 'string') return
    if (method === 'Network.requestWillBeSentExtraInfo') {
      if (!p.headers) return
      if (pending.has(id)) pending.get(id)!.headers = p.headers
      else if (extraHeaders.size < 64) extraHeaders.set(id, p.headers)
      return
    }
    if (method === 'Network.requestWillBeSent') {
      if (p.redirectResponse && pending.has(id)) {
        fail('REVIEW_REQUEST_REDIRECTED')
        return
      }
      if (p.frameId !== frameId) return
      if (p.type === 'Document') {
        if (selected) {
          fail('REVIEW_PAGE_CHANGED')
          return
        }
        if (origin(p.request?.url) !== config.page_origin) {
          fail('REVIEW_ORIGIN_CHANGED')
          return
        }
        pageUrl = p.request!.url
        loaderId = p.loaderId ?? ''
        pending.clear()
        extraHeaders.clear()
        return
      }
      if (
        !['Fetch', 'XHR'].includes(p.type ?? '') ||
        p.loaderId !== loaderId ||
        origin(p.documentURL) !== config.page_origin ||
        origin(p.request?.url) !== config.origin
      )
        return
      if (p.redirectResponse) {
        if (selected) fail('REVIEW_REQUEST_REDIRECTED')
        return
      }
      if (pending.size >= 64) {
        fail('REVIEW_REQUEST_LIMIT')
        return
      }
      if (
        typeof p.request?.method !== 'string' ||
        typeof p.request?.url !== 'string' ||
        p.request.url.length > 4096
      )
        return
      if (p.request.postData && byteLength(p.request.postData) > 8192) return
      pending.set(id, {
        request: p.request,
        headers: extraHeaders.get(id),
        type: p.type!,
        documentUrl: p.documentURL!,
        bytes: 0,
      })
      extraHeaders.delete(id)
      return
    }
    const item = pending.get(id)
    if (!item) return
    if (method === 'Network.responseReceived') item.response = p.response
    else if (
      method === 'Network.dataReceived' &&
      typeof p.dataLength === 'number' &&
      Number.isSafeInteger(p.dataLength) &&
      p.dataLength >= 0
    )
      item.bytes = Math.min(BODY_LIMIT + 1, item.bytes + p.dataLength)
    else if (method === 'Network.loadingFinished') void finish(id, item)
    else if (method === 'Network.loadingFailed') {
      item.response = undefined
      void finish(id, item)
    }
  }
  const timeout = setTimeout(
    () => fail(selected ? 'REVIEW_EXPIRED' : 'NO_REQUEST_OBSERVED'),
    120_000,
  )
  const dispose = async () => {
    if (disposed) return
    if (!selected) fail('REVIEW_CANCELLED')
    disposed = true
    clearTimeout(timeout)
    pending.clear()
    extraHeaders.clear()
    selectedCredentials = null
    signal.removeEventListener('abort', abort)
    chrome.tabs.onUpdated.removeListener(updated)
    chrome.tabs.onRemoved.removeListener(removed)
    chrome.debugger.onEvent.removeListener(event)
    chrome.debugger.onDetach.removeListener(detached)
    if (attached) {
      attached = false
      await chrome.debugger.detach(target).catch(() => {})
    }
  }
  try {
    signal.addEventListener('abort', abort, { once: true })
    chrome.tabs.onUpdated.addListener(updated)
    chrome.tabs.onRemoved.addListener(removed)
    chrome.debugger.onEvent.addListener(event)
    chrome.debugger.onDetach.addListener(detached)
    await cancellable(
      chrome.debugger.attach(target, '1.3').then(async () => {
        if (disposed) {
          await chrome.debugger.detach(target).catch(() => {})
          return
        }
        attached = true
      }),
    )
    const tree = (await cancellable(
      chrome.debugger.sendCommand(target, 'Page.getFrameTree'),
    )) as {
      frameTree: { frame: { id: string; loaderId: string; url: string } }
    }
    const frame = tree.frameTree.frame
    if (origin(frame.url) !== config.page_origin)
      throw new Error('REVIEW_WRONG_TAB')
    frameId = frame.id
    loaderId = frame.loaderId
    pageUrl = frame.url
    await cancellable(
      chrome.debugger.sendCommand(target, 'Network.enable', {
        maxTotalBufferSize: BODY_LIMIT * 4,
        maxResourceBufferSize: BODY_LIMIT,
        maxPostDataSize: 8192,
      }),
    )
    if (signal.aborted || invalid)
      throw new Error(invalid ?? 'REVIEW_CANCELLED')
    input.onReady()
    return {
      read,
      invalidated,
      dispose,
      async assertCurrent() {
        const current = await chrome.tabs.get(tabId)
        if (
          invalid ||
          disposed ||
          signal.aborted ||
          current.url !== pageUrl ||
          current.pendingUrl
        )
          throw new Error(invalid ?? 'REVIEW_PAGE_CHANGED')
      },
    }
  } catch (error) {
    await dispose()
    throw error
  }
}
