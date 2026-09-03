import {
  installPageApiObserver,
  type PageApiObserverOptions,
} from '@/lib/zktls/discovery/page-api-observer'

type DiscoveryContext = {
  readonly isInvalid: boolean
  onInvalidated: (callback: () => void) => void
}

/** Session-owned activation/ready hooks; a page message is not authorization. */
export function createDiscoveryContentController(ctx: DiscoveryContext) {
  let release: (() => void) | undefined
  let invalidated = ctx.isInvalid
  const stop = () => {
    release?.()
    release = undefined
  }
  ctx.onInvalidated(() => {
    invalidated = true
    stop()
  })
  return {
    start(options: PageApiObserverOptions) {
      if (invalidated || ctx.isInvalid) return
      stop()
      release = installPageApiObserver({ ...options, onReady: undefined })
      // Save cleanup before readiness: the caller may stop/invalidate immediately.
      try {
        void Promise.resolve(options.onReady?.()).catch(() => undefined)
      } catch {}
    },
    stop,
  }
}

export default defineContentScript({
  registration: 'runtime',
  world: 'MAIN',
  main() {
    // Deliberately idle until the session manager wires its authorized handshake.
    // No static matches, feature auto-enable, storage, or proof engine dependency.
    // WXT MAIN-world scripts receive no ContentScriptContext. The bridge must
    // explicitly supply the controller's invalidation lifecycle when connected.
  },
})
