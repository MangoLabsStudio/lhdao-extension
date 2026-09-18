export const PRODUCT_EXPERIENCE_PROOF_VERSION = 'product-experience-v1' as const
export const PRODUCT_EXPERIENCE_CAPABILITY = 'product-experience-v1' as const
export const PRODUCT_EXPERIENCE_PAGE_CHANNEL = 'product-experience-v1' as const

const PAGE_REQUEST_TYPES = new Set([
  'get-public-product-experience-state',
  'save-product-experience-task',
])

export type ProductExperienceCondition =
  | { type: 'ELEMENT_EXISTS' }
  | { type: 'TEXT_CONTAINS'; expected: string }
  | {
      type: 'ATTRIBUTE_EQUALS'
      attributeName: string
      expected: string
    }
  | { type: 'COUNT_AT_LEAST'; minimumCount: number }

export interface ProductExperienceRule {
  id: string
  title: string
  urlPattern: string
  selector: string
  condition: ProductExperienceCondition
}

export interface ProductExperienceRuleMatch {
  ruleId: string
  matchedAt: string
  origin: string
  urlPathHash: string
}

export interface ProductExperienceCanonicalInput {
  version: typeof PRODUCT_EXPERIENCE_PROOF_VERSION
  campaignId: string
  ruleSetVersion: number
  nonce: string
  ts: number
  ruleMatches: ProductExperienceRuleMatch[]
}

export interface ProductExperienceEvaluationInput {
  href: string
  now?: Date
  rules: ProductExperienceRule[]
  root?: ParentNode
}

export interface ProductExperienceEvaluationResult {
  matchedRuleIds: string[]
  ruleMatches: ProductExperienceRuleMatch[]
  totalRuleCount: number
}

export function isProductExperiencePageRequest(value: unknown): value is {
  channel: typeof PRODUCT_EXPERIENCE_PAGE_CHANNEL
  type: 'get-public-product-experience-state' | 'save-product-experience-task'
  correlationId: string
} {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as { channel?: unknown }).channel ===
      PRODUCT_EXPERIENCE_PAGE_CHANNEL &&
    typeof (value as { correlationId?: unknown }).correlationId === 'string' &&
    typeof (value as { type?: unknown }).type === 'string' &&
    PAGE_REQUEST_TYPES.has((value as { type: string }).type)
  )
}

export function compareUtf16CodeUnits(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

export function buildProductExperienceCanonical(
  input: ProductExperienceCanonicalInput,
): string {
  if (input.version !== PRODUCT_EXPERIENCE_PROOF_VERSION) {
    throw new Error('PRODUCT_EXPERIENCE_VERSION_INVALID')
  }
  return JSON.stringify({
    version: PRODUCT_EXPERIENCE_PROOF_VERSION,
    campaignId: input.campaignId,
    ruleSetVersion: input.ruleSetVersion,
    nonce: input.nonce,
    ts: input.ts,
    ruleMatches: [...input.ruleMatches]
      .sort((left, right) => compareUtf16CodeUnits(left.ruleId, right.ruleId))
      .map((match) => ({
        ruleId: match.ruleId,
        matchedAt: new Date(match.matchedAt).toISOString(),
        origin: new URL(match.origin).origin,
        urlPathHash: match.urlPathHash,
      })),
  })
}

export async function evaluateProductExperienceRules({
  href,
  now = new Date(),
  rules,
  root = document,
}: ProductExperienceEvaluationInput): Promise<ProductExperienceEvaluationResult> {
  const matchedAt = now.toISOString()
  const currentUrl = safeUrl(href)
  if (!currentUrl) {
    return { matchedRuleIds: [], ruleMatches: [], totalRuleCount: rules.length }
  }
  const origin = currentUrl.origin
  const urlPathHash = await sha256Hex(
    `${currentUrl.pathname}${currentUrl.search}`,
  )
  const ruleMatches: ProductExperienceRuleMatch[] = []

  for (const rule of rules) {
    if (!urlMatchesPattern(currentUrl, rule.urlPattern)) continue
    if (!ruleConditionMatches(root, rule)) continue
    ruleMatches.push({
      ruleId: rule.id,
      matchedAt,
      origin,
      urlPathHash,
    })
  }

  return {
    matchedRuleIds: ruleMatches.map((match) => match.ruleId),
    ruleMatches,
    totalRuleCount: rules.length,
  }
}

export function randomProductExperienceNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function hmacSignProductExperienceProof(
  macKeyB64url: string,
  canonical: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    b64urlToBytes(macKeyB64url) as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(canonical) as BufferSource,
  )
  return bytesToB64url(sig)
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function ruleConditionMatches(
  root: ParentNode,
  rule: ProductExperienceRule,
): boolean {
  const condition = rule.condition
  let elements: Element[]
  try {
    elements = Array.from(root.querySelectorAll(rule.selector))
  } catch {
    return false
  }
  if (condition.type === 'ELEMENT_EXISTS') {
    return elements.length > 0
  }
  if (condition.type === 'COUNT_AT_LEAST') {
    return elements.length >= condition.minimumCount
  }
  if (condition.type === 'TEXT_CONTAINS') {
    return elements.some((element) =>
      (element.textContent ?? '').includes(condition.expected),
    )
  }
  if (condition.type === 'ATTRIBUTE_EQUALS') {
    return elements.some(
      (element) =>
        element.getAttribute(condition.attributeName) === condition.expected,
    )
  }
  return false
}

function urlMatchesPattern(currentUrl: URL, pattern: string): boolean {
  const patternUrl = safeUrl(pattern)
  if (!patternUrl || patternUrl.origin !== currentUrl.origin) return false
  const current = stripHash(currentUrl.href)
  const expected = stripHash(patternUrl.href)
  const source = expected
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'u').test(current)
}

function stripHash(value: string): string {
  const hashIndex = value.indexOf('#')
  return hashIndex === -1 ? value : value.slice(0, hashIndex)
}

function safeUrl(value: string): URL | null {
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' &&
      !(
        url.protocol === 'http:' &&
        ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      )
    ) {
      return null
    }
    return url
  } catch {
    return null
  }
}

function b64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  const bin = atob(b64 + pad)
  const out = new Uint8Array(bin.length)
  for (let index = 0; index < bin.length; index += 1) {
    out[index] = bin.charCodeAt(index)
  }
  return out
}

function bytesToB64url(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (const byte of bytes) bin += String.fromCharCode(byte)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
