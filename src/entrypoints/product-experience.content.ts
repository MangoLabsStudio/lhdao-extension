import {
  createProductExperienceEvidenceMessage,
  createProductExperienceWatcherLifecycle,
  startProductExperienceWatcher,
} from '@/lib/product-experience-watcher'
import type {
  ProductExperienceCondition,
  ProductExperienceRule,
} from '@/types/product-experience'

interface ProductExperienceBootstrap {
  sessionId: string
  ruleSetVersion: number
  allowedOrigins: string[]
  completionMode: 'ALL'
  evaluationMode: 'STRICT' | 'SELECTOR_ONLY'
  rules: ProductExperienceRule[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCondition(value: unknown): ProductExperienceCondition | null {
  if (!isRecord(value) || typeof value.type !== 'string') return null
  switch (value.type) {
    case 'ELEMENT_EXISTS':
      return { type: 'ELEMENT_EXISTS' }
    case 'TEXT_CONTAINS':
      return typeof value.expected === 'string'
        ? { type: 'TEXT_CONTAINS', expected: value.expected }
        : null
    case 'ATTRIBUTE_EQUALS':
      return typeof value.attributeName === 'string' &&
        typeof value.expected === 'string'
        ? {
            type: 'ATTRIBUTE_EQUALS',
            attributeName: value.attributeName,
            expected: value.expected,
          }
        : null
    case 'COUNT_AT_LEAST':
      return Number.isInteger(value.minimumCount) &&
        (value.minimumCount as number) > 0
        ? {
            type: 'COUNT_AT_LEAST',
            minimumCount: value.minimumCount as number,
          }
        : null
    case 'NUMERIC_AT_LEAST':
      return typeof value.minimumValue === 'number' &&
        Number.isFinite(value.minimumValue) &&
        value.minimumValue > 0
        ? {
            type: 'NUMERIC_AT_LEAST',
            minimumValue: value.minimumValue,
          }
        : null
    default:
      return null
  }
}

function parseRule(value: unknown): ProductExperienceRule | null {
  if (!isRecord(value)) return null
  const condition = parseCondition(value.condition)
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.urlPattern !== 'string' ||
    typeof value.selector !== 'string' ||
    !condition
  ) {
    return null
  }
  return {
    id: value.id,
    title: value.title,
    urlPattern: value.urlPattern,
    selector: value.selector,
    condition,
  }
}

function parseBootstrap(value: unknown): ProductExperienceBootstrap | null {
  if (
    !isRecord(value) ||
    typeof value.sessionId !== 'string' ||
    value.sessionId.length === 0 ||
    value.sessionId.length > 256 ||
    !Number.isInteger(value.ruleSetVersion) ||
    value.completionMode !== 'ALL' ||
    (value.evaluationMode !== 'STRICT' &&
      value.evaluationMode !== 'SELECTOR_ONLY') ||
    !Array.isArray(value.allowedOrigins) ||
    !value.allowedOrigins.every((origin) => typeof origin === 'string') ||
    !Array.isArray(value.rules) ||
    value.rules.length === 0 ||
    value.rules.length > 20
  ) {
    return null
  }

  const rules = value.rules.map(parseRule)
  if (rules.some((rule) => rule === null)) return null
  return {
    sessionId: value.sessionId,
    ruleSetVersion: value.ruleSetVersion as number,
    allowedOrigins: [...value.allowedOrigins] as string[],
    completionMode: 'ALL',
    evaluationMode: value.evaluationMode,
    rules: rules as ProductExperienceRule[],
  }
}

export default defineContentScript({
  registration: 'runtime',
  world: 'ISOLATED',
  async main(ctx) {
    // Runtime injection must remain top-frame only. The controller also checks
    // sender.frameId === 0 before returning the rule configuration.
    if (window.top !== window) return

    const lifecycle = createProductExperienceWatcherLifecycle(ctx)

    let bootstrap: ProductExperienceBootstrap | null = null
    try {
      const response: unknown = await chrome.runtime.sendMessage({
        type: 'product-experience-bootstrap',
      })
      bootstrap = parseBootstrap(response)
    } catch {
      lifecycle.stop()
      return
    }
    if (!bootstrap || lifecycle.isStopped() || ctx.isInvalid) {
      lifecycle.stop()
      return
    }

    try {
      await chrome.runtime.sendMessage({
        type: 'product-experience-ready',
        sessionId: bootstrap.sessionId,
      })
    } catch {
      lifecycle.stop()
      return
    }
    if (lifecycle.isStopped() || ctx.isInvalid) {
      lifecycle.stop()
      return
    }

    const watcher = startProductExperienceWatcher({
      rules: bootstrap.rules,
      allowedOrigins: bootstrap.allowedOrigins,
      completionMode: bootstrap.completionMode,
      evaluationMode: bootstrap.evaluationMode,
      onEvidence(matches) {
        void chrome.runtime
          .sendMessage(
            createProductExperienceEvidenceMessage(
              bootstrap.sessionId,
              matches,
            ),
          )
          .catch(lifecycle.stop)
      },
      onStatus() {
        // The empty, credential-free evidence message lets the background
        // validate the sender's new origin and move the session to reauthorize.
        void chrome.runtime
          .sendMessage(
            createProductExperienceEvidenceMessage(bootstrap.sessionId, []),
          )
          .catch(lifecycle.stop)
        lifecycle.stop()
      },
    })
    lifecycle.attach(watcher)
  },
})
