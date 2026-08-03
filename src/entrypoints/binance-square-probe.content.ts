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

export function installBinanceSquareProbe(enabled = CAPTURE_DEBUG): void {
  if (!enabled) return
  let targets: BinanceProbeTarget[] = []

  window.addEventListener('message', (event) => {
    if (event.source !== window || event.origin !== window.location.origin) {
      return
    }
    const parsed = parseProbeTargetConfigMessage(event.data)
    if (parsed) targets = parsed
  })

  const emit = (args: {
    url: string
    status: number
    request: unknown
    response: unknown
  }) => {
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
  window.fetch = function (...args: Parameters<typeof fetch>) {
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

  const state = new WeakMap<XMLHttpRequest, { method: string; url: string }>()
  const pendingLoad = new WeakMap<XMLHttpRequest, () => void>()
  const removePendingLoad = (xhr: XMLHttpRequest) => {
    const listener = pendingLoad.get(xhr)
    if (!listener) return
    pendingLoad.delete(xhr)
    xhr.removeEventListener('load', listener)
  }
  const originalOpen = XMLHttpRequest.prototype.open
  const originalSend = XMLHttpRequest.prototype.send
  XMLHttpRequest.prototype.open = function (...args: unknown[]) {
    removePendingLoad(this)
    state.set(this, {
      method: String(args[0] ?? 'GET'),
      url: String(args[1] ?? ''),
    })
    return (originalOpen as (...values: unknown[]) => void).apply(this, args)
  }
  XMLHttpRequest.prototype.send = function (...args: unknown[]) {
    removePendingLoad(this)
    const requestState = state.get(this)
    const candidate =
      targets.length > 0 &&
      isBinanceProbeCandidate(requestState?.url, requestState?.method ?? 'GET')
    if (candidate && requestState) {
      const requestBody = readBody(
        undefined,
        (args[0] ?? null) as BodyInit | null,
      )
      const loadListener = () => {
        if (pendingLoad.get(this) === loadListener) {
          pendingLoad.delete(this)
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
      pendingLoad.set(this, loadListener)
      this.addEventListener('load', loadListener)
    }
    try {
      return (originalSend as (...values: unknown[]) => void).apply(this, args)
    } catch (error) {
      removePendingLoad(this)
      throw error
    }
  }
}

export default defineContentScript({
  matches: MATCHES,
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installBinanceSquareProbe()
  },
})
