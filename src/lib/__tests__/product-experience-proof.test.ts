import { describe, expect, it } from 'vitest'
import {
  buildProductExperienceCanonical,
  compareUtf16CodeUnits,
  PRODUCT_EXPERIENCE_PROOF_VERSION,
  type ProductExperienceCanonicalInput,
  signProductExperienceProof,
} from '../product-experience-proof'
import vectorFixture from './fixtures/product-experience-proof-vector.json'

type GoldenVector = {
  input: ProductExperienceCanonicalInput
  macKey: string
  canonical: string
  signature: string
}

const vector = vectorFixture as GoldenVector

async function signature(input: ProductExperienceCanonicalInput) {
  return signProductExperienceProof(vector.macKey, input)
}

describe('product experience proof canonical', () => {
  it('matches the backend golden canonical and HMAC vector', async () => {
    expect(buildProductExperienceCanonical(vector.input)).toBe(vector.canonical)
    expect(await signature(vector.input)).toBe(vector.signature)
  })

  it('uses the product domain tag and rejects another proof protocol', () => {
    expect(JSON.parse(vector.canonical).version).toBe(
      PRODUCT_EXPERIENCE_PROOF_VERSION,
    )
    expect(() =>
      buildProductExperienceCanonical({
        ...vector.input,
        version: 'engagement-v1',
      } as unknown as ProductExperienceCanonicalInput),
    ).toThrow('PRODUCT_EXPERIENCE_VERSION_INVALID')
  })

  it('sorts rule ids by JavaScript UTF-16 code units', () => {
    const base = vector.input.ruleMatches[0]
    const canonical = JSON.parse(
      buildProductExperienceCanonical({
        ...vector.input,
        ruleMatches: [
          { ...base, ruleId: 'a2' },
          { ...base, ruleId: 'b' },
          { ...base, ruleId: 'a10' },
        ],
      }),
    )

    expect(
      canonical.ruleMatches.map((match: { ruleId: string }) => match.ruleId),
    ).toEqual(['a10', 'a2', 'b'])
    expect(['\uE000', '\u{10000}'].sort(compareUtf16CodeUnits)).toEqual([
      '\u{10000}',
      '\uE000',
    ])
  })

  it('normalizes timestamps to UTC ISO and origins without paths', () => {
    const input = structuredClone(vector.input)
    input.ruleMatches = input.ruleMatches.map((match) => ({
      ...match,
      matchedAt:
        match.ruleId === 'rule-a'
          ? '2026-07-13T18:00:01+08:00'
          : '2026-07-13T18:00:02+08:00',
      origin: 'https://CLIENT.example:443/a/path?ignored=yes#fragment',
    }))

    expect(buildProductExperienceCanonical(input)).toBe(vector.canonical)
  })

  it('does not mutate caller-owned rule order', () => {
    const input = structuredClone(vector.input)
    const original = structuredClone(input.ruleMatches)

    buildProductExperienceCanonical(input)

    expect(input.ruleMatches).toEqual(original)
  })

  it.each([
    ['campaignId', { campaignId: 'changed-campaign' }],
    ['ruleSetVersion', { ruleSetVersion: 4 }],
    ['nonce', { nonce: 'ffeeddccbbaa99887766554433221100' }],
    ['ts', { ts: vector.input.ts + 1 }],
  ] satisfies Array<
    [string, Partial<ProductExperienceCanonicalInput>]
  >)('changes the HMAC when %s changes', async (_, change) => {
    expect(await signature({ ...vector.input, ...change })).not.toBe(
      vector.signature,
    )
  })

  it.each([
    ['ruleId', 'changed-rule'],
    ['matchedAt', '2026-07-13T10:00:03.000Z'],
    ['origin', 'https://other.example/path'],
    [
      'urlPathHash',
      'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    ],
  ] as const)('changes the HMAC when rule match %s changes', async (field, value) => {
    const input = structuredClone(vector.input)
    input.ruleMatches[0] = { ...input.ruleMatches[0], [field]: value }

    expect(await signature(input)).not.toBe(vector.signature)
  })

  it.each([
    ['invalid matchedAt', { matchedAt: 'not-a-date' }],
    ['invalid origin', { origin: 'not-a-url' }],
  ])('fails closed for %s', (_, change) => {
    const input = structuredClone(vector.input)
    input.ruleMatches[0] = { ...input.ruleMatches[0], ...change }

    expect(() => buildProductExperienceCanonical(input)).toThrow()
  })
})
