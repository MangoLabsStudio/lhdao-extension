import {
  type BinanceProbeObservation,
  type BinanceProbeTarget,
  parseProbeObservationMessage,
  parseProbeTargetConfigMessage,
} from '@/lib/binance-square-probe'
import { CAPTURE_DEBUG } from '@/lib/capture-debug'
import { sendMessage } from '@/lib/messaging'

const MATCHES = [
  'https://www.binance.com/*/square/*',
  'https://www.binance.com/square/*',
]

const BRIDGE_INSTALLATION = Symbol.for(
  'lhdao.binance-square-bridge.installation',
)

type BridgeInstallation = {
  cleanup: () => void
}

function installationStore(): Record<PropertyKey, unknown> {
  return globalThis as unknown as Record<PropertyKey, unknown>
}

export function probeObservationFromEvent(
  event: MessageEvent,
  currentTargets: readonly BinanceProbeTarget[],
  expectedSource: Window,
  expectedOrigin: string,
): BinanceProbeObservation | null {
  if (event.source !== expectedSource || event.origin !== expectedOrigin) {
    return null
  }
  const observation = parseProbeObservationMessage(event.data)
  return observation &&
    currentTargets.some(
      (target) =>
        target.kind === observation.target.kind &&
        target.id === observation.target.id,
    )
    ? observation
    : null
}

export function installBinanceSquareBridge(
  enabled = CAPTURE_DEBUG,
): () => void {
  const store = installationStore()
  const existing = store[BRIDGE_INSTALLATION] as BridgeInstallation | undefined
  if (!enabled) {
    existing?.cleanup()
    return () => undefined
  }
  existing?.cleanup()

  let disposed = false
  let refreshGeneration = 0
  let currentTargets: BinanceProbeTarget[] = []

  const publishTargets = async () => {
    const generation = ++refreshGeneration
    try {
      const response = await sendMessage({ type: 'get-binance-probe-targets' })
      if (disposed || generation !== refreshGeneration) return
      if (response.type !== 'binance-probe-targets') return
      const targets = parseProbeTargetConfigMessage({
        __lhBinanceProbeConfig: true,
        targets: response.targets,
      })
      if (!targets) return
      currentTargets = targets
      window.postMessage(
        { __lhBinanceProbeConfig: true, targets },
        window.location.origin,
      )
    } catch {}
  }

  const onRuntimeMessage = (message: unknown) => {
    if (disposed) return
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === 'tasks-updated'
    ) {
      void publishTargets()
    }
  }
  const onWindowMessage = (event: MessageEvent) => {
    if (disposed) return
    const observation = probeObservationFromEvent(
      event,
      currentTargets,
      window,
      window.location.origin,
    )
    if (!observation) return
    void sendMessage({
      type: 'report-binance-probe-observation',
      observation,
    }).catch(() => {})
  }
  const installation: BridgeInstallation = {
    cleanup: () => {
      if (disposed) return
      disposed = true
      refreshGeneration += 1
      window.removeEventListener('message', onWindowMessage)
      try {
        chrome.runtime.onMessage.removeListener(onRuntimeMessage)
      } catch {}
      if (store[BRIDGE_INSTALLATION] === installation) {
        Reflect.deleteProperty(store, BRIDGE_INSTALLATION)
      }
    },
  }
  store[BRIDGE_INSTALLATION] = installation
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  window.addEventListener('message', onWindowMessage)
  void publishTargets()
  return installation.cleanup
}

export default defineContentScript({
  matches: MATCHES,
  world: 'ISOLATED',
  runAt: 'document_start',
  main(ctx) {
    const cleanup = installBinanceSquareBridge()
    ctx.onInvalidated(cleanup)
  },
})
