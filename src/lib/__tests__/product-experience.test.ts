import { describe, expect, it } from 'vitest'
import {
  buildProductExperienceCanonical,
  evaluateProductExperienceRules,
  hmacSignProductExperienceProof,
  isProductExperiencePageRequest,
  sha256Hex,
} from '@/lib/product-experience'

const vector = {
  input: {
    version: 'product-experience-v1' as const,
    campaignId: 'campaign-product-001',
    ruleSetVersion: 3,
    nonce: '00112233445566778899aabbccddeeff',
    ts: 1783936800,
    ruleMatches: [
      {
        ruleId: 'rule-b',
        matchedAt: '2026-07-13T10:00:02.000Z',
        origin: 'https://client.example',
        urlPathHash:
          'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      {
        ruleId: 'rule-a',
        matchedAt: '2026-07-13T10:00:01.000Z',
        origin: 'https://client.example',
        urlPathHash:
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    ],
  },
  macKey: 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8',
  canonical:
    '{"version":"product-experience-v1","campaignId":"campaign-product-001","ruleSetVersion":3,"nonce":"00112233445566778899aabbccddeeff","ts":1783936800,"ruleMatches":[{"ruleId":"rule-a","matchedAt":"2026-07-13T10:00:01.000Z","origin":"https://client.example","urlPathHash":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},{"ruleId":"rule-b","matchedAt":"2026-07-13T10:00:02.000Z","origin":"https://client.example","urlPathHash":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}]}',
  signature: '7nWOEGmTstvkkP7rrkfxzsU70gtshNBYw6NAJcElHNo',
}

describe('product experience proof helpers', () => {
  it('only treats page-to-extension requests as bridge requests', () => {
    expect(
      isProductExperiencePageRequest({
        channel: 'product-experience-v1',
        type: 'get-public-product-experience-state',
        correlationId: 'request-1',
      }),
    ).toBe(true)
    expect(
      isProductExperiencePageRequest({
        channel: 'product-experience-v1',
        type: 'save-product-experience-task',
        correlationId: 'request-2',
      }),
    ).toBe(true)
    expect(
      isProductExperiencePageRequest({
        channel: 'product-experience-v1',
        type: 'public-product-experience-state-result',
        correlationId: 'response-1',
      }),
    ).toBe(false)
    expect(
      isProductExperiencePageRequest({
        channel: 'product-experience-v1',
        type: 'product-experience-state-changed',
      }),
    ).toBe(false)
  })

  it('matches the backend canonical and HMAC golden vector', async () => {
    const canonical = buildProductExperienceCanonical(vector.input)

    expect(canonical).toBe(vector.canonical)
    await expect(
      hmacSignProductExperienceProof(vector.macKey, canonical),
    ).resolves.toBe(vector.signature)
  })

  it('hashes the normalized URL path without leaking the full URL', async () => {
    await expect(sha256Hex('/dashboard?tab=done#ignored')).resolves.toMatch(
      /^[0-9a-f]{64}$/,
    )
    await expect(sha256Hex('/dashboard?tab=done#ignored')).resolves.toBe(
      await sha256Hex('/dashboard?tab=done#ignored'),
    )
  })

  it('matches all supported rule condition types against the current page', async () => {
    document.body.innerHTML = `
      <main>
        <button data-lighthouse-complete="true">开始使用产品</button>
        <section id="status" data-state="done">体验完成</section>
        <ul>
          <li class="step">A</li>
          <li class="step">B</li>
        </ul>
      </main>
    `

    const result = await evaluateProductExperienceRules({
      href: 'https://client.example/dashboard?tab=done#fragment',
      now: new Date('2026-07-13T10:00:00.000Z'),
      rules: [
        {
          id: 'exists',
          title: 'exists',
          urlPattern: 'https://client.example/*',
          selector: '[data-lighthouse-complete="true"]',
          condition: { type: 'ELEMENT_EXISTS' },
        },
        {
          id: 'text',
          title: 'text',
          urlPattern: 'https://client.example/dashboard*',
          selector: '#status',
          condition: { type: 'TEXT_CONTAINS', expected: '完成' },
        },
        {
          id: 'attr',
          title: 'attr',
          urlPattern: 'https://client.example/dashboard*',
          selector: '#status',
          condition: {
            type: 'ATTRIBUTE_EQUALS',
            attributeName: 'data-state',
            expected: 'done',
          },
        },
        {
          id: 'count',
          title: 'count',
          urlPattern: 'https://client.example/dashboard*',
          selector: '.step',
          condition: { type: 'COUNT_AT_LEAST', minimumCount: 2 },
        },
      ],
    })

    expect(result.matchedRuleIds).toEqual(['exists', 'text', 'attr', 'count'])
    expect(result.ruleMatches).toHaveLength(4)
    expect(
      result.ruleMatches.every(
        (match) =>
          match.origin === 'https://client.example' &&
          /^[0-9a-f]{64}$/.test(match.urlPathHash),
      ),
    ).toBe(true)
  })

  it('does not match rules for another origin or an invalid selector', async () => {
    document.body.innerHTML = '<button data-lighthouse-complete="true" />'

    const result = await evaluateProductExperienceRules({
      href: 'https://client.example/dashboard',
      now: new Date('2026-07-13T10:00:00.000Z'),
      rules: [
        {
          id: 'origin',
          title: 'origin',
          urlPattern: 'https://other.example/*',
          selector: '[data-lighthouse-complete="true"]',
          condition: { type: 'ELEMENT_EXISTS' },
        },
        {
          id: 'selector',
          title: 'selector',
          urlPattern: 'https://client.example/*',
          selector: '[',
          condition: { type: 'ELEMENT_EXISTS' },
        },
      ],
    })

    expect(result.matchedRuleIds).toEqual([])
    expect(result.ruleMatches).toEqual([])
  })
})
