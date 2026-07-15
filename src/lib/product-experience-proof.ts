import type { ProductRuleMatch } from '../types/product-experience'
import { hmacSha256Base64Url } from './proof-crypto'

export const PRODUCT_EXPERIENCE_PROOF_VERSION = 'product-experience-v1' as const

export interface ProductExperienceCanonicalInput {
  version: typeof PRODUCT_EXPERIENCE_PROOF_VERSION
  campaignId: string
  ruleSetVersion: number
  nonce: string
  ts: number
  ruleMatches: ProductRuleMatch[]
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

export async function signProductExperienceProof(
  macKeyBase64Url: string,
  input: ProductExperienceCanonicalInput,
): Promise<string> {
  return hmacSha256Base64Url(
    macKeyBase64Url,
    buildProductExperienceCanonical(input),
  )
}
