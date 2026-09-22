import {
  type BinanceProbeTarget,
  buildProbeObservation,
  findProbeTarget,
  parseProbeTargetConfigMessage,
} from '@/lib/binance-square-probe'
import { CAPTURE_DEBUG } from '@/lib/capture-debug'

const MATCHES = [
  'https://www.binance.com/*/square/*',
  'https://www.binance.com/square/*',
]

// This page-world marker only owns patch lifecycle. It is not an authorization
// signal; observations still pass the isolated bridge and background checks.
const PROBE_INSTALLATION = Symbol.for('lhdao.binance-square-probe.installation')
const PROBE_GENERATION = Object.freeze({})

type ProbeInstallation = {
  generation: object
  owners: number
  disposed: boolean
  originalFetch: typeof window.fetch
  fetchWrapper: typeof window.fetch
  xhrPrototype: typeof XMLHttpRequest.prototype
  originalOpen: typeof XMLHttpRequest.prototype.open
  openWrapper: typeof XMLHttpRequest.prototype.open
  originalSend: typeof XMLHttpRequest.prototype.send
  sendWrapper: typeof XMLHttpRequest.prototype.send
  onConfigMessage: (event: MessageEvent) => void
  pendingLoad: WeakMap<XMLHttpRequest, () => void>
  pendingXhrs: Set<XMLHttpRequest>
}

function installationStore(): Record<PropertyKey, unknown> {
  return window as unknown as Record<PropertyKey, unknown>
}

function disposeProbeInstallation(installation: ProbeInstallation): void {
  if (installation.disposed) return
  installation.disposed = true
  window.removeEventListener('message', installation.onConfigMessage)
  for (const xhr of installation.pendingXhrs) {
    const listener = installation.pendingLoad.get(xhr)
    if (listener) xhr.removeEventListener('load', listener)
  }
  installation.pendingXhrs.clear()
  if (window.fetch === installation.fetchWrapper) {
    window.fetch = installation.originalFetch
  }
  if (installation.xhrPrototype.open === installation.openWrapper) {
    installation.xhrPrototype.open = installation.originalOpen
  }
  if (installation.xhrPrototype.send === installation.sendWrapper) {
    installation.xhrPrototype.send = installation.originalSend
  }
  const store = installationStore()
  if (store[PROBE_INSTALLATION] === installation) {
    Reflect.deleteProperty(store, PROBE_INSTALLATION)
  }
}

function releaseProbeInstallation(installation: ProbeInstallation): () => void {
  let released = false
  return () => {
    if (released || installation.disposed) return
    released = true
    installation.owners -= 1
    if (installation.owners === 0) disposeProbeInstallation(installation)
  }
}

export function isBinanceProbeCandidate(
  url: string | undefined,
  method: string,
  baseUrl = window.location.href,
): boolean {
  if (!url || method.toUpperCase() !== 'POST') return false
  try {
    const parsed = new URL(url, baseUrl)
    return (
      parsed.origin === 'https://www.binance.com' &&
      parsed.pathname.startsWith('/bapi/')
    )
  } catch {
    return false
  }
}

function urlOf(input: unknown): string | undefined {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return (input as Request | undefined)?.url
}

async function readBody(
  input: RequestInfo | URL | undefined,
  body: BodyInit | null | undefined,
): Promise<string | undefined> {
  try {
    if (typeof body === 'string') return body
    if (body instanceof URLSearchParams) return body.toString()
    if (body instanceof Blob) return body.text().catch(() => undefined)
    if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
    if (ArrayBuffer.isView(body)) {
      return new TextDecoder().decode(body as ArrayBufferView<ArrayBuffer>)
    }
    if (input instanceof Request && input.body != null) {
      return input
        .clone()
        .text()
        .catch(() => undefined)
    }
  } catch {}
  return undefined
}

function json(text: string | undefined): unknown {
  if (!text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export function installBinanceSquareProbe(enabled = CAPTURE_DEBUG): () => void {
  const store = installationStore()
  const existing = store[PROBE_INSTALLATION] as ProbeInstallation | undefined
  if (!enabled) {
    if (existing) disposeProbeInstallation(existing)
    return () => undefined
  }
  if (
    existing &&
    !existing.disposed &&
    existing.generation === PROBE_GENERATION &&
    window.fetch === existing.fetchWrapper &&
    XMLHttpRequest.prototype.open === existing.openWrapper &&
    XMLHttpRequest.prototype.send === existing.sendWrapper
  ) {
    existing.owners += 1
    return releaseProbeInstallation(existing)
  }
  if (existing) disposeProbeInstallation(existing)

  let installation: ProbeInstallation | undefined
  let targets: BinanceProbeTarget[] = []

  const onConfigMessage = (event: MessageEvent) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return
    }
    const parsed = parseProbeTargetConfigMessage(event.data)
    if (parsed) targets = parsed
  }
  window.addEventListener('message', onConfigMessage)

  const emit = (args: {
    url: string
    status: number
    request: unknown
    response: unknown
  }) => {
    if (installation?.disposed) return
    const observation = buildProbeObservation({
      ...args,
      method: 'POST',
      targets,
      capturedAt: new Date().toISOString(),
    })
    if (!observation) return
    try {
      window.postMessage(
        { __lhBinanceProbe: true, observation },
        window.location.origin,
      )
    } catch {}
  }

  const originalFetch = window.fetch
  const fetchWrapper = function (
    this: typeof window,
    ...args: Parameters<typeof fetch>
  ) {
    const input = args[0]
    const init = args[1]
    let url: string | undefined
    let candidate = false
    try {
      url = urlOf(input)
      const method =
        init?.method ?? (input instanceof Request ? input.method : 'GET')
      candidate = targets.length > 0 && isBinanceProbeCandidate(url, method)
    } catch {}
    const requestBody = candidate ? readBody(input, init?.body) : null
    const result = originalFetch.apply(this, args)
    if (candidate && url && requestBody) {
      void result
        .then(async (response) => {
          const request = json(await requestBody)
          if (!findProbeTarget(request, targets)) return
          const responseJson = await response
            .clone()
            .json()
            .catch(() => null)
          emit({
            url,
            status: response.status,
            request,
            response: responseJson,
          })
        })
        .catch(() => undefined)
    }
    return result
  }
  window.fetch = fetchWrapper

  const state = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
  const pendingLoad = new WeakMap<XMLHttpRequest, () => void>()
  const pendingXhrs = new Set<XMLHttpRequest>()
  const removePendingLoad = (xhr: XMLHttpRequest) => {
    const listener = pendingLoad.get(xhr)
    if (!listener) return
    pendingLoad.delete(xhr)
    pendingXhrs.delete(xhr)
    xhr.removeEventListener('load', listener)
  }
  const xhrPrototype = XMLHttpRequest.prototype
  const originalOpen = xhrPrototype.open
  const originalSend = xhrPrototype.send
  const openWrapper = function (this: XMLHttpRequest, ...args: unknown[]) {
    const result = (originalOpen as (...values: unknown[]) => unknown).apply(
      this,
      args,
    )
    removePendingLoad(this)
    state.set(this, {
      method: String(args[0] ?? 'GET'),
      url: String(args[1] ?? ''),
    })
    return result
  }
  const sendWrapper = function (this: XMLHttpRequest, ...args: unknown[]) {
    const previousLoad = pendingLoad.get(this)
    const requestState = state.get(this)
    const candidate =
      targets.length > 0 &&
      isBinanceProbeCandidate(requestState?.url, requestState?.method ?? 'GET')
    if (candidate && requestState) {
      const requestBody = readBody(
        undefined,
        (args[0] ?? null) as BodyInit | null,
      )
      let loadCompleted = false
      const loadListener = () => {
        loadCompleted = true
        if (pendingLoad.get(this) === loadListener) {
          pendingLoad.delete(this)
          pendingXhrs.delete(this)
        }
        this.removeEventListener('load', loadListener)
        const status = this.status
        let response: unknown = null
        try {
          response =
            this.responseType === 'json'
              ? this.response
              : JSON.parse(this.responseText)
        } catch {}
        void requestBody.then((text) => {
          const request = json(text)
          if (!findProbeTarget(request, targets)) return
          emit({
            url: requestState.url,
            status,
            request,
            response,
          })
        })
      }
      this.addEventListener('load', loadListener)
      if (previousLoad) this.removeEventListener('load', previousLoad)
      try {
        const result = (
          originalSend as (...values: unknown[]) => unknown
        ).apply(this, args)
        if (pendingLoad.get(this) === previousLoad) pendingLoad.delete(this)
        if (loadCompleted) {
          pendingXhrs.delete(this)
        } else {
          pendingLoad.set(this, loadListener)
          pendingXhrs.add(this)
        }
        return result
      } catch (error) {
        this.removeEventListener('load', loadListener)
        if (previousLoad) this.addEventListener('load', previousLoad)
        throw error
      }
    }
    try {
      if (previousLoad) this.removeEventListener('load', previousLoad)
      const result = (originalSend as (...values: unknown[]) => unknown).apply(
        this,
        args,
      )
      if (pendingLoad.get(this) === previousLoad) {
        pendingLoad.delete(this)
        pendingXhrs.delete(this)
      }
      return result
    } catch (error) {
      if (previousLoad) this.addEventListener('load', previousLoad)
      throw error
    }
  }
  xhrPrototype.open = openWrapper as typeof XMLHttpRequest.prototype.open
  xhrPrototype.send = sendWrapper as typeof XMLHttpRequest.prototype.send

  installation = {
    generation: PROBE_GENERATION,
    owners: 1,
    disposed: false,
    originalFetch,
    fetchWrapper,
    xhrPrototype,
    originalOpen,
    openWrapper: xhrPrototype.open,
    originalSend,
    sendWrapper: xhrPrototype.send,
    onConfigMessage,
    pendingLoad,
    pendingXhrs,
  }
  store[PROBE_INSTALLATION] = installation
  return releaseProbeInstallation(installation)
}

export default defineContentScript({
  matches: MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installBinanceSquareProbe()
  },
})
