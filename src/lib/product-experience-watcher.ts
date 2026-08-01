import type {
  ProductExperienceRule,
  ProductRuleMatch,
} from '@/types/product-experience'
import { evaluateProductRule } from './product-experience-rules'

const MUTATION_DEBOUNCE_MS = 300
const URL_POLL_INTERVAL_MS = 250
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

export type ProductExperienceWatcherStatus =
  | 'origin-not-allowed'
  | 'evaluation-error'

export interface ProductExperienceWatcherOptions {
  rules: readonly ProductExperienceRule[]
  allowedOrigins: readonly string[]
  completionMode: 'ALL'
  evaluationMode?: 'STRICT' | 'SELECTOR_ONLY'
  onEvidence: (matches: ProductRuleMatch[]) => void
  onStatus?: (status: ProductExperienceWatcherStatus) => void
}

export interface ProductExperienceWatcher {
  stop(): void
}

export interface ProductExperienceRuntimeContext {
  readonly isInvalid: boolean
  onInvalidated(callback: () => void): () => void
}

export interface ProductExperienceWatcherLifecycle {
  attach(watcher: ProductExperienceWatcher): void
  isStopped(): boolean
  stop(): void
}

export interface ProductExperienceEvidenceMessage {
  type: 'product-experience-evidence'
  sessionId: string
  matches: ProductRuleMatch[]
}

function sanitizeMatch(match: ProductRuleMatch): ProductRuleMatch {
  return {
    ruleId: match.ruleId,
    matchedAt: match.matchedAt,
    origin: match.origin,
    urlPathHash: match.urlPathHash,
  }
}

export function createProductExperienceEvidenceMessage(
  sessionId: string,
  matches: readonly ProductRuleMatch[],
): ProductExperienceEvidenceMessage {
  return {
    type: 'product-experience-evidence',
    sessionId,
    matches: matches.map(sanitizeMatch),
  }
}

function isSafePageUrl(url: URL): boolean {
  if (url.username.length > 0 || url.password.length > 0) return false
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(url.hostname)
}

function normalizeAllowedOrigins(origins: readonly string[]): Set<string> {
  const normalized = new Set<string>()
  for (const origin of origins) {
    try {
      const parsed = new URL(origin)
      if (isSafePageUrl(parsed)) normalized.add(parsed.origin)
    } catch {
      // Invalid allowlist entries fail closed.
    }
  }
  return normalized
}

function currentPageIsAllowed(allowedOrigins: ReadonlySet<string>): boolean {
  try {
    const currentUrl = new URL(window.location.href)
    return isSafePageUrl(currentUrl) && allowedOrigins.has(currentUrl.origin)
  } catch {
    return false
  }
}

export function createProductExperienceWatcherLifecycle(
  context: ProductExperienceRuntimeContext,
): ProductExperienceWatcherLifecycle {
  let watcher: ProductExperienceWatcher | null = null
  let stopped = false
  let removeInvalidatedListener = (): void => {}

  const stop = (): void => {
    if (stopped) return
    stopped = true
    watcher?.stop()
    window.removeEventListener('pagehide', stop)
    removeInvalidatedListener()
  }

  removeInvalidatedListener = context.onInvalidated(stop)
  window.addEventListener('pagehide', stop, { once: true })
  if (context.isInvalid) stop()

  return {
    attach(nextWatcher) {
      if (stopped || context.isInvalid) {
        nextWatcher.stop()
        stop()
        return
      }
      watcher = nextWatcher
    },
    isStopped: () => stopped,
    stop,
  }
}

export function startProductExperienceWatcher(
  options: ProductExperienceWatcherOptions,
): ProductExperienceWatcher {
  const rules = [...options.rules]
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins)
  const matchesByRuleId = new Map<string, ProductRuleMatch>()
  let running = true
  let evaluating = false
  let evaluationQueued = false
  let mutationTimer: ReturnType<typeof setTimeout> | undefined
  let lastHref = window.location.href

  const observer = new MutationObserver(() => {
    if (!running) return
    if (mutationTimer !== undefined) clearTimeout(mutationTimer)
    mutationTimer = setTimeout(() => {
      mutationTimer = undefined
      requestEvaluation()
    }, MUTATION_DEBOUNCE_MS)
  })

  const onRouteChange = (): void => {
    if (!running) return
    lastHref = window.location.href
    requestEvaluation()
  }

  const urlPollTimer = setInterval(() => {
    if (!running) return
    const nextHref = window.location.href
    if (nextHref === lastHref) return
    lastHref = nextHref
    requestEvaluation()
  }, URL_POLL_INTERVAL_MS)

  const stop = (): void => {
    if (!running) return
    running = false
    evaluationQueued = false
    observer.disconnect()
    if (mutationTimer !== undefined) {
      clearTimeout(mutationTimer)
      mutationTimer = undefined
    }
    clearInterval(urlPollTimer)
    window.removeEventListener('popstate', onRouteChange)
    window.removeEventListener('hashchange', onRouteChange)
  }

  const stopWithStatus = (status: ProductExperienceWatcherStatus): void => {
    if (!running) return
    try {
      options.onStatus?.(status)
    } catch {
      // Status transport failures must not create an unhandled rejection.
    } finally {
      stop()
    }
  }

  const configuredMatchOrder = (): ProductRuleMatch[] => {
    const ordered: ProductRuleMatch[] = []
    const emittedRuleIds = new Set<string>()
    for (const rule of rules) {
      if (emittedRuleIds.has(rule.id)) continue
      const match = matchesByRuleId.get(rule.id)
      if (!match) continue
      emittedRuleIds.add(rule.id)
      ordered.push(sanitizeMatch(match))
    }
    return ordered
  }

  const evaluate = async (): Promise<void> => {
    if (!running) return
    if (!currentPageIsAllowed(allowedOrigins)) {
      stopWithStatus('origin-not-allowed')
      return
    }

    const href = window.location.href
    const pendingRules = rules.filter((rule) => !matchesByRuleId.has(rule.id))
    const results = await Promise.all(
      pendingRules.map((rule) =>
        evaluateProductRule(rule, document, href, {
          allowLoopbackHttp: true,
          evaluationMode: options.evaluationMode,
        }),
      ),
    )
    if (!running) return
    if (!currentPageIsAllowed(allowedOrigins)) {
      stopWithStatus('origin-not-allowed')
      return
    }

    let addedMatch = false
    for (const match of results) {
      if (!match || matchesByRuleId.has(match.ruleId)) continue
      matchesByRuleId.set(match.ruleId, sanitizeMatch(match))
      addedMatch = true
    }
    if (!addedMatch) return

    try {
      options.onEvidence(configuredMatchOrder())
    } catch {
      // A transport callback cannot make the watcher inspect or log page data.
    }
  }

  function requestEvaluation(): void {
    if (!running) return
    if (evaluating) {
      evaluationQueued = true
      return
    }

    evaluating = true
    void evaluate()
      .catch(() => {
        stopWithStatus('evaluation-error')
      })
      .finally(() => {
        evaluating = false
        if (!running || !evaluationQueued) return
        evaluationQueued = false
        requestEvaluation()
      })
  }

  window.addEventListener('popstate', onRouteChange)
  window.addEventListener('hashchange', onRouteChange)
  if (document.documentElement) {
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    })
  }

  // Start the first asynchronous rule evaluation immediately, without waiting
  // for a mutation, route event, or polling interval.
  requestEvaluation()

  return { stop }
}
