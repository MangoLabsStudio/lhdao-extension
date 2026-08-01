import type {
  ProductExperienceCondition,
  ProductExperienceRule,
  ProductRuleMatch,
} from '../types/product-experience'
import { sha256Hex } from './proof-crypto'

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]'])
const EXACT_LOOPBACK_HTTP_URL =
  /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?(?:\/|$)/
const URL_PATTERN_FORBIDDEN_CHARACTERS = /[()[\]{}|+?^$\\]/
const MAX_URL_PATTERN_LENGTH = 512
const MAX_SELECTOR_LENGTH = 512

export interface ProductRuleEvaluationOptions {
  allowLoopbackHttp?: boolean
  evaluationMode?: 'STRICT' | 'SELECTOR_ONLY'
  now?: () => Date
}

function isLoopbackHttp(rawUrl: string, url: URL): boolean {
  return (
    url.protocol === 'http:' &&
    LOOPBACK_HOSTNAMES.has(url.hostname) &&
    EXACT_LOOPBACK_HTTP_URL.test(rawUrl)
  )
}

function parseRuleUrlPattern(
  pattern: string,
  allowLoopbackHttp: boolean,
): URL | null {
  if (
    pattern.length === 0 ||
    pattern.length > MAX_URL_PATTERN_LENGTH ||
    pattern.includes('\\') ||
    pattern.includes('?') ||
    pattern.includes('#')
  ) {
    return null
  }

  let parsed: URL
  try {
    parsed = new URL(pattern)
  } catch {
    return null
  }

  if (
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hostname.includes('*') ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    return null
  }

  if (parsed.protocol !== 'https:') {
    if (!allowLoopbackHttp || !isLoopbackHttp(pattern, parsed)) return null
  }

  let decodedPath: string
  try {
    decodedPath = decodeURIComponent(parsed.pathname)
  } catch {
    return null
  }
  if (URL_PATTERN_FORBIDDEN_CHARACTERS.test(decodedPath)) return null

  return parsed
}

function parsePageUrl(href: string, allowLoopbackHttp: boolean): URL | null {
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return null
  }

  if (parsed.username.length > 0 || parsed.password.length > 0) return null
  if (parsed.protocol === 'https:') return parsed
  if (allowLoopbackHttp && isLoopbackHttp(href, parsed)) return parsed
  return null
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&')
}

function pathnameMatchesGlob(pattern: string, pathname: string): boolean {
  const source = pattern
    .split('*')
    .map((part) => escapeRegularExpression(part))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(pathname)
}

function isVisible(element: Element, ownerDocument: Document): boolean {
  const view = ownerDocument.defaultView
  if (!view) return false

  const style = view.getComputedStyle(element)
  if (
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse'
  ) {
    return false
  }

  const opacity = Number.parseFloat(style.opacity)
  if (!Number.isFinite(opacity) || opacity <= 0) return false

  return [...element.getClientRects()].some(
    (rect) => rect.width > 0 && rect.height > 0,
  )
}

function isAllowedAttributeName(attributeName: string): boolean {
  return (
    attributeName === 'class' ||
    (attributeName.startsWith('aria-') && attributeName.length > 5) ||
    (attributeName.startsWith('data-') && attributeName.length > 5)
  )
}

function parseVisibleNumericValue(text: string): number | null {
  const match = text
    .replaceAll(',', '')
    .match(/[-+]?\d+(?:\.\d+)?\s*(?:[kKmMbB]|万|亿)?/u)
  if (!match) return null

  const [, rawValue, rawUnit = ''] =
    /^([-+]?\d+(?:\.\d+)?)\s*([kKmMbB]|万|亿)?$/u.exec(match[0].trim()) ?? []
  const value = Number(rawValue)
  if (!Number.isFinite(value)) return null

  const unit = rawUnit.toLowerCase()
  const multiplier =
    unit === 'k'
      ? 1_000
      : unit === 'm'
        ? 1_000_000
        : unit === 'b'
          ? 1_000_000_000
          : rawUnit === '万'
            ? 10_000
            : rawUnit === '亿'
              ? 100_000_000
              : 1

  return value * multiplier
}

function conditionMatches(
  condition: ProductExperienceCondition,
  visibleElements: Element[],
): boolean {
  switch (condition.type) {
    case 'ELEMENT_EXISTS':
      return visibleElements.length > 0
    case 'TEXT_CONTAINS':
      return (
        typeof condition.expected === 'string' &&
        visibleElements.some((element) =>
          element.textContent?.includes(condition.expected),
        )
      )
    case 'ATTRIBUTE_EQUALS':
      return (
        typeof condition.attributeName === 'string' &&
        typeof condition.expected === 'string' &&
        isAllowedAttributeName(condition.attributeName) &&
        visibleElements.some(
          (element) =>
            element.getAttribute(condition.attributeName) ===
            condition.expected,
        )
      )
    case 'COUNT_AT_LEAST':
      return (
        Number.isInteger(condition.minimumCount) &&
        condition.minimumCount > 0 &&
        visibleElements.length >= condition.minimumCount
      )
    case 'NUMERIC_AT_LEAST':
      return (
        typeof condition.minimumValue === 'number' &&
        Number.isFinite(condition.minimumValue) &&
        condition.minimumValue > 0 &&
        visibleElements.some((element) => {
          const value = parseVisibleNumericValue(element.textContent ?? '')
          return value !== null && value >= condition.minimumValue
        })
      )
    default:
      return false
  }
}

export async function evaluateProductRule(
  rule: ProductExperienceRule,
  ownerDocument: Document,
  href: string,
  options: ProductRuleEvaluationOptions = {},
): Promise<ProductRuleMatch | null> {
  const allowLoopbackHttp = options.allowLoopbackHttp ?? true
  const pattern = parseRuleUrlPattern(rule.urlPattern, allowLoopbackHttp)
  const pageUrl = parsePageUrl(href, allowLoopbackHttp)
  if (!pattern || !pageUrl) return null
  if (pattern.origin !== pageUrl.origin) return null
  if (!pathnameMatchesGlob(pattern.pathname, pageUrl.pathname)) return null
  if (
    typeof rule.id !== 'string' ||
    rule.id.length === 0 ||
    typeof rule.selector !== 'string' ||
    rule.selector.length === 0 ||
    rule.selector.length > MAX_SELECTOR_LENGTH
  ) {
    return null
  }

  let elements: Element[]
  try {
    elements = [...ownerDocument.querySelectorAll(rule.selector)]
  } catch {
    return null
  }
  const visibleElements = elements.filter((element) =>
    isVisible(element, ownerDocument),
  )
  if (
    options.evaluationMode !== 'SELECTOR_ONLY' &&
    !conditionMatches(rule.condition, visibleElements)
  ) {
    return null
  }
  if (visibleElements.length === 0) return null

  return {
    ruleId: rule.id,
    matchedAt: (options.now?.() ?? new Date()).toISOString(),
    origin: pageUrl.origin,
    urlPathHash: await sha256Hex(pageUrl.pathname),
  }
}
