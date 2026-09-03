import {
  type DiscoveryRequest,
  parseDiscoveryRequest,
} from '../../product-experience-task-bridge'
import { type CandidateSnapshot, CandidateStore } from './candidate-store'
import { BODY_LIMIT, byteLength, freezeCopy, safeClone } from './redaction'

export type DiscoveryCode =
  | 'INVALID_REQUEST'
  | 'INVALID_SENDER'
  | 'NO_SESSION'
  | 'BUSY'
  | 'ATTACH_FAILED'
  | 'DETACHED'
  | 'ORIGIN_CHANGED'
  | 'OWNER_NAVIGATED'
  | 'TAB_CLOSED'
  | 'EXPIRED'
  | 'QUOTA_REACHED'
  | 'STOPPED'
  | 'EXTENSION_ERROR'
export type DiscoverySnapshot = CandidateSnapshot & {
  schema: 1
  sessionId: string
  pageOrigin: string
  status: 'ready' | 'stopped'
  reason: DiscoveryCode | null
  startedAt: number
  expiresAt: number
}
export type DiscoveryResponse = {
  type: 'discovery-result'
  requestType: DiscoveryRequest['type']
  correlationId: string
} & (
  | { ok: true; snapshot: DiscoverySnapshot }
  | { ok: false; code: DiscoveryCode }
)
type Pending = {
  epoch: number
  at: number
  method: string
  url: string
  documentUrl: string
  requestBody?: string
  requestHeaders: unknown
  responseHeaders: unknown
  contentType: string
  status: number
  reading?: boolean
  decodedBytes: number
  oversized: boolean
}
type Session = {
  id: string
  ownerTab: number
  ownerDocument?: string
  ownerUrl: string
  targetTab?: number
  origin: string
  frameId?: string
  loaderId?: string
  epoch: number
  attached: boolean
  ready: boolean
  stopped: boolean
  reason: DiscoveryCode | null
  startedAt: number
  deadline: number
  store: CandidateStore
  pending: Map<string, Pending>
  timer?: ReturnType<typeof setInterval>
  targetLoaded?: () => void
  interruptSetup?: () => void
}
const TTL = 15 * 60 * 1000
const PENDING_TTL = 30_000
const MAX_PENDING = 64

function originOf(value: unknown): string | null {
  try {
    return typeof value === 'string' ? new URL(value).origin : null
  } catch {
    return null
  }
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function erase(pending: Pending) {
  pending.url = ''
  pending.documentUrl = ''
  pending.requestBody = undefined
  pending.requestHeaders = {}
  pending.responseHeaders = {}
}
function clearPending(session: Session) {
  for (const pending of session.pending.values()) erase(pending)
  session.pending.clear()
}

/** Ephemeral native observer. No storage, replay, page patching, or proof runtime. */
export class DiscoverySessionManager {
  private session: Session | null = null
  private notification?: ReturnType<typeof setTimeout>
  private disposed = false

  constructor(private lighthouseOrigin: string) {
    chrome.debugger?.onEvent.addListener(this.onEvent)
    chrome.debugger?.onDetach.addListener(this.onDetach)
    chrome.tabs.onUpdated.addListener(this.onTabUpdated)
    chrome.tabs.onRemoved.addListener(this.tabRemoved)
    // Chrome 118+ keeps workers alive during debugger sessions. Unloading the
    // extension detaches Chrome's debugger. Never guess ownership via getTargets.
  }

  async handle(
    input: unknown,
    sender: chrome.runtime.MessageSender,
  ): Promise<DiscoveryResponse> {
    const request = parseDiscoveryRequest(input)
    const envelope = {
      type: 'discovery-result' as const,
      requestType: request?.type ?? ('start-discovery' as const),
      correlationId: request?.correlationId ?? '',
    }
    const fail = (code: DiscoveryCode): DiscoveryResponse => ({
      ...envelope,
      ok: false,
      code,
    })
    if (!request) return fail('INVALID_REQUEST')
    const ownerTab = sender.tab?.id
    if (
      this.disposed ||
      sender.id !== chrome.runtime.id ||
      sender.frameId !== 0 ||
      !Number.isInteger(ownerTab) ||
      originOf(sender.url) !== this.lighthouseOrigin
    )
      return fail('INVALID_SENDER')
    if (request.type === 'start-discovery') {
      if (this.session && !this.session.stopped) return fail('BUSY')
      const session: Session = {
        id: crypto.randomUUID(),
        ownerTab: ownerTab as number,
        ownerDocument: sender.documentId,
        ownerUrl: sender.url as string,
        origin: new URL(request.targetUrl).origin,
        epoch: 0,
        attached: false,
        ready: false,
        stopped: false,
        reason: null,
        startedAt: Date.now(),
        deadline: performance.now() + TTL,
        store: new CandidateStore(),
        pending: new Map(),
      }
      this.session = session
      clearTimeout(this.notification)
      this.notification = undefined
      session.timer = setInterval(() => {
        if (!this.active(session)) return
        if (
          !session.ready &&
          performance.now() >= session.deadline - TTL + PENDING_TTL
        ) {
          this.stop(session, 'ATTACH_FAILED')
          return
        }
        for (const [id, pending] of session.pending)
          if (performance.now() - pending.at >= PENDING_TTL) {
            erase(pending)
            session.pending.delete(id)
          }
      }, 1000)
      const interrupted = new Promise<DiscoveryResponse>((resolve) => {
        session.interruptSetup = () =>
          resolve(fail(session.reason ?? 'ATTACH_FAILED'))
      })
      const setup = (async (): Promise<DiscoveryResponse> => {
        try {
          const liveOwner = await chrome.tabs.get(session.ownerTab)
          if (!this.active(session) || liveOwner.url !== session.ownerUrl) {
            this.stop(session, 'OWNER_NAVIGATED')
            return fail('INVALID_SENDER')
          }
          const tab = await chrome.tabs.create({
            url: request.targetUrl,
            active: true,
          })
          if (!this.active(session)) return fail(session.reason ?? 'NO_SESSION')
          if (tab.id === undefined) {
            this.stop(session, 'ATTACH_FAILED')
            return fail('ATTACH_FAILED')
          }
          session.targetTab = tab.id
          if (
            tab.url &&
            tab.url !== 'about:blank' &&
            originOf(tab.url) !== session.origin
          ) {
            this.stop(session, 'ORIGIN_CHANGED')
            return fail('ORIGIN_CHANGED')
          }
          await chrome.debugger.attach({ tabId: tab.id }, '1.3')
          session.attached = true
          if (!this.active(session)) {
            this.detach(session)
            return fail(session.reason ?? 'NO_SESSION')
          }
          await chrome.debugger.sendCommand(
            { tabId: tab.id },
            'Network.enable',
            {
              maxTotalBufferSize: 1024 * 1024,
              maxResourceBufferSize: BODY_LIMIT,
              maxPostDataSize: BODY_LIMIT,
            },
          )
          if (!this.active(session)) return fail(session.reason ?? 'NO_SESSION')
          // Target tabs.url may be hidden without broad tabs/host permission.
          // Native root metadata is authoritative; wait only for navigation events.
          let frame: Record<string, unknown> | null
          do {
            const epoch = session.epoch
            const tree = record(
              safeClone(
                await chrome.debugger.sendCommand(
                  { tabId: tab.id },
                  'Page.getFrameTree',
                ),
              ),
            )
            if (!this.active(session))
              return fail(session.reason ?? 'NO_SESSION')
            frame = record(record(tree?.frameTree)?.frame)
            if (frame?.url !== 'about:blank') break
            if (session.epoch === epoch)
              await new Promise<void>((resolve) => {
                session.targetLoaded = resolve
              })
            if (!this.active(session))
              return fail(session.reason ?? 'NO_SESSION')
          } while (this.active(session))
          if (originOf(frame?.url) !== session.origin) {
            this.stop(session, 'ORIGIN_CHANGED')
            return fail('ORIGIN_CHANGED')
          }
          if (typeof frame?.id !== 'string') {
            this.stop(session, 'ATTACH_FAILED')
            return fail('ATTACH_FAILED')
          }
          session.frameId = frame.id
          session.loaderId =
            typeof frame.loaderId === 'string' ? frame.loaderId : undefined
          session.ready = true
          session.interruptSetup = undefined
          this.notify(session)
          return { ...envelope, ok: true, snapshot: this.snapshot(session) }
        } catch {
          this.stop(session, 'ATTACH_FAILED')
          return fail(session.reason ?? 'ATTACH_FAILED')
        }
      })()
      return Promise.race([setup, interrupted])
    }
    const session = this.session
    if (!session || session.id !== request.sessionId) return fail('NO_SESSION')
    if (
      session.ownerTab !== ownerTab ||
      session.ownerDocument !== sender.documentId ||
      session.ownerUrl !== sender.url
    )
      return fail('INVALID_SENDER')
    this.active(session)
    const liveOwner = await chrome.tabs.get(session.ownerTab).catch(() => null)
    if (this.session !== session) return fail('NO_SESSION')
    if (liveOwner && liveOwner.url !== session.ownerUrl) {
      this.stop(session, 'OWNER_NAVIGATED')
      return fail('INVALID_SENDER')
    }
    if (request.type === 'stop-discovery') this.stop(session, 'STOPPED')
    return { ...envelope, ok: true, snapshot: this.snapshot(session) }
  }

  private active(session: Session): boolean {
    if (this.disposed || this.session !== session || session.stopped)
      return false
    if (performance.now() >= session.deadline) {
      this.stop(session, 'EXPIRED')
      return false
    }
    return true
  }
  private snapshot(session: Session): DiscoverySnapshot {
    return freezeCopy({
      schema: 1,
      sessionId: session.id,
      pageOrigin: session.origin,
      status: session.stopped ? 'stopped' : 'ready',
      reason: session.reason,
      startedAt: session.startedAt,
      expiresAt: session.startedAt + TTL,
      ...session.store.snapshot(),
    })
  }
  private notify(session: Session) {
    if (this.notification) return
    this.notification = setTimeout(() => {
      this.notification = undefined
      if (this.disposed || this.session !== session) return
      void chrome.tabs
        .sendMessage(session.ownerTab, { type: 'discovery-snapshot-changed' })
        .catch(() => undefined)
    }, 200)
  }
  private detach(session: Session) {
    if (!session.attached || session.targetTab === undefined) return
    session.attached = false
    void chrome.debugger
      .detach({ tabId: session.targetTab })
      .catch(() => undefined)
  }
  private stop(session: Session, reason: DiscoveryCode) {
    if (session.stopped) return
    session.stopped = true
    session.reason = reason
    session.epoch += 1
    clearPending(session)
    session.store.clear()
    clearInterval(session.timer)
    session.targetLoaded?.()
    session.targetLoaded = undefined
    session.interruptSetup?.()
    session.interruptSetup = undefined
    this.detach(session)
    this.notify(session)
  }
  tabUpdated(tabId: number, change: { status?: string; url?: string }) {
    const session = this.session
    if (!session || !this.active(session)) return
    if (
      tabId === session.ownerTab &&
      (change.status === 'loading' ||
        (change.url && change.url !== session.ownerUrl))
    ) {
      this.stop(session, 'OWNER_NAVIGATED')
      return
    }
    if (tabId !== session.targetTab) return
    if (change.url && originOf(change.url) !== session.origin) {
      this.stop(session, 'ORIGIN_CHANGED')
      return
    }
    if (
      change.status === 'complete' ||
      change.status === 'loading' ||
      (change.url && originOf(change.url) === session.origin)
    ) {
      session.targetLoaded?.()
      session.targetLoaded = undefined
    }
    if (change.status === 'loading') {
      session.epoch += 1
      clearPending(session)
      // Chrome may deliver the new Document event before tabs.onUpdated.
      // Clearing pending reads is sufficient; the native loader ID stays authoritative.
    }
  }
  private onTabUpdated = (tabId: number, change: chrome.tabs.TabChangeInfo) =>
    this.tabUpdated(tabId, change)
  tabRemoved = (tabId: number) => {
    const session = this.session
    if (session && (tabId === session.ownerTab || tabId === session.targetTab))
      this.stop(session, 'TAB_CLOSED')
  }
  private onDetach = (source: chrome.debugger.Debuggee) => {
    const session = this.session
    if (
      session &&
      source.tabId === session.targetTab &&
      !source.targetId &&
      !source.extensionId
    ) {
      session.attached = false
      this.stop(session, 'DETACHED')
    }
  }
  private onEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    input?: object,
  ) => {
    const session = this.session
    if (
      !session ||
      !this.active(session) ||
      !session.ready ||
      source.tabId !== session.targetTab ||
      source.targetId ||
      source.extensionId ||
      'sessionId' in source
    )
      return
    if (
      ![
        'Network.requestWillBeSent',
        'Network.responseReceived',
        'Network.dataReceived',
        'Network.loadingFinished',
        'Network.loadingFailed',
      ].includes(method)
    )
      return
    const params = record(safeClone(input))
    if (
      !params ||
      typeof params.requestId !== 'string' ||
      params.requestId.length > 256
    )
      return
    const id = params.requestId
    if (method === 'Network.requestWillBeSent') {
      const request = record(params.request)
      if (!request || typeof request.url !== 'string') return
      if (params.frameId !== session.frameId) return
      if (params.type === 'Document') {
        if (originOf(request.url) !== session.origin) {
          this.stop(session, 'ORIGIN_CHANGED')
          return
        }
        session.epoch += 1
        clearPending(session)
        session.loaderId =
          typeof params.loaderId === 'string' ? params.loaderId : undefined
        return
      }
      if (
        typeof params.type !== 'string' ||
        !['Fetch', 'XHR'].includes(params.type) ||
        !session.loaderId ||
        params.loaderId !== session.loaderId ||
        originOf(params.documentURL) !== session.origin
      )
        return
      if (
        !/^https?:\/\//.test(request.url) ||
        request.url.length > 4096 ||
        typeof request.method !== 'string'
      )
        return
      if (session.pending.size >= MAX_PENDING && !session.pending.has(id)) {
        this.stop(session, 'QUOTA_REACHED')
        return
      }
      const post =
        typeof request.postData === 'string'
          ? request.postData
          : request.hasPostData
            ? undefined
            : ''
      const replaced = session.pending.get(id)
      if (replaced) erase(replaced)
      session.pending.set(id, {
        epoch: session.epoch,
        at: performance.now(),
        method: request.method,
        url: request.url,
        documentUrl: params.documentURL as string,
        requestBody:
          post && (post.length > BODY_LIMIT || byteLength(post) > BODY_LIMIT)
            ? ' '.repeat(BODY_LIMIT + 1)
            : post,
        requestHeaders: request.headers ?? {},
        responseHeaders: {},
        contentType: '',
        status: 0,
        decodedBytes: 0,
        oversized: false,
      })
      return
    }
    const pending = session.pending.get(id)
    if (!pending || pending.epoch !== session.epoch) return
    if (method === 'Network.responseReceived') {
      const response = record(params.response)
      pending.contentType =
        typeof response?.mimeType === 'string' ? response.mimeType : ''
      pending.responseHeaders = response?.headers ?? {}
      pending.status =
        typeof response?.status === 'number' ? response.status : 0
      const headers = record(response?.headers)
      if (headers) {
        const lower = Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name.toLowerCase(),
            value,
          ]),
        )
        const encoding = lower['content-encoding']
        const length = lower['content-length']
        if (
          (encoding === undefined ||
            (typeof encoding === 'string' &&
              encoding.trim().toLowerCase() === 'identity')) &&
          typeof length === 'string' &&
          /^\d+$/.test(length) &&
          Number(length) > BODY_LIMIT
        )
          pending.oversized = true
      }
    } else if (method === 'Network.dataReceived') {
      if (
        typeof params.dataLength !== 'number' ||
        !Number.isSafeInteger(params.dataLength) ||
        params.dataLength < 0
      )
        return
      pending.decodedBytes = Math.min(
        BODY_LIMIT + 1,
        pending.decodedBytes + params.dataLength,
      )
      if (pending.decodedBytes > BODY_LIMIT) pending.oversized = true
    } else if (method === 'Network.loadingFailed') {
      session.pending.delete(id)
      this.insert(session, pending)
    } else if (method === 'Network.loadingFinished') {
      if (pending.reading) return
      pending.reading = true
      if (pending.oversized) {
        session.pending.delete(id)
        this.insert(session, pending, ' '.repeat(BODY_LIMIT + 1))
        return
      }
      // Keep entry through the async read; refresh/stop/timeout clears it.
      if (
        !/^application\/(?:[\w.-]+\+)?json(?:\s*;|\s*$)/i.test(
          pending.contentType,
        )
      ) {
        session.pending.delete(id)
        this.insert(session, pending)
        return
      }
      void chrome.debugger
        .sendCommand({ tabId: session.targetTab }, 'Network.getResponseBody', {
          requestId: id,
        })
        .then((result) => {
          if (
            !this.active(session) ||
            pending.epoch !== session.epoch ||
            session.pending.get(id) !== pending
          )
            return
          session.pending.delete(id)
          const data = record(safeClone(result))
          let text: string | undefined
          if (typeof data?.body === 'string') {
            if (data.body.length > Math.ceil(BODY_LIMIT / 3) * 4)
              text = ' '.repeat(BODY_LIMIT + 1)
            else if (data.base64Encoded === true) {
              try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(
                  Uint8Array.from(atob(data.body), (character) =>
                    character.charCodeAt(0),
                  ),
                )
              } catch {
                /* unavailable */
              }
            } else text = data.body
          }
          this.insert(session, pending, text)
        })
        .catch(() => {
          if (
            !this.active(session) ||
            pending.epoch !== session.epoch ||
            session.pending.get(id) !== pending
          )
            return
          session.pending.delete(id)
          this.insert(session, pending)
        })
    }
  }
  private insert(session: Session, pending: Pending, responseBody?: string) {
    if (!this.active(session) || pending.epoch !== session.epoch) return
    if (pending.oversized) responseBody = ' '.repeat(BODY_LIMIT + 1)
    const result = session.store.add({
      method: pending.method,
      url: pending.url,
      documentUrl: pending.documentUrl,
      requestHeaders: pending.requestHeaders,
      responseHeaders: pending.responseHeaders,
      requestBody: pending.requestBody,
      contentType: pending.contentType,
      status: pending.status,
      responseBody,
    })
    erase(pending)
    if (result === 'quota') this.stop(session, 'QUOTA_REACHED')
    else if (result === 'added') this.notify(session)
  }
  dispose() {
    if (this.session) this.stop(this.session, 'STOPPED')
    this.disposed = true
    clearTimeout(this.notification)
    chrome.debugger?.onEvent.removeListener(this.onEvent)
    chrome.debugger?.onDetach.removeListener(this.onDetach)
    chrome.tabs.onUpdated.removeListener(this.onTabUpdated)
    chrome.tabs.onRemoved.removeListener(this.tabRemoved)
  }
}
