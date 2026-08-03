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

export function installBinanceSquareBridge(enabled = CAPTURE_DEBUG): void {
  if (!enabled) return
  let currentTargets: BinanceProbeTarget[] = []

  const publishTargets = async () => {
    try {
      const response = await sendMessage({ type: 'get-binance-probe-targets' })
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

  void publishTargets()
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'tasks-updated') void publishTargets()
  })
  window.addEventListener('message', (event) => {
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
  })
}

export default defineContentScript({
  matches: MATCHES,
  world: 'ISOLATED',
  runAt: 'document_start',
  main() {
    installBinanceSquareBridge()
  },
})
