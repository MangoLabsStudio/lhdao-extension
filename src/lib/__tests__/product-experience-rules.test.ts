import { beforeEach, describe, expect, it } from 'vitest'
import type {
  ProductExperienceCondition,
  ProductExperienceRule,
} from '../../types/product-experience'
import { evaluateProductRule } from '../product-experience-rules'

const CLIENT_URL = 'https://client.example/onboarding/done'

function rule(
  condition: ProductExperienceCondition,
  overrides: Partial<ProductExperienceRule> = {},
): ProductExperienceRule {
  return {
    id: 'onboarding-done',
    title: 'Complete onboarding',
    urlPattern: 'https://client.example/onboarding/*',
    selector: '[data-onboarding-state]',
    condition,
    ...overrides,
  }
}

function element(
  attributes: Record<string, string> = {
    'data-onboarding-state': 'complete',
  },
  text = 'Welcome, setup complete',
): HTMLElement {
  const node = document.createElement('div')
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, value)
  }
  node.textContent = text
  node.style.display = 'block'
  node.style.visibility = 'visible'
  node.style.opacity = '1'
  Object.defineProperty(node, 'getClientRects', {
    configurable: true,
    value: () => [{ width: 10, height: 10 }],
  })
  document.body.append(node)
  return node
}

function hide(
  node: HTMLElement,
  kind: 'display' | 'visibility' | 'opacity' | 'rect',
) {
  if (kind === 'display') node.style.display = 'none'
  if (kind === 'visibility') node.style.visibility = 'hidden'
  if (kind === 'opacity') node.style.opacity = '0'
  if (kind === 'rect') {
    Object.defineProperty(node, 'getClientRects', {
      configurable: true,
      value: () => [{ width: 0, height: 10 }],
    })
  }
}

describe('evaluateProductRule', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it.each([
    ['ELEMENT_EXISTS', { type: 'ELEMENT_EXISTS' }],
    ['TEXT_CONTAINS', { type: 'TEXT_CONTAINS', expected: 'setup complete' }],
    [
      'ATTRIBUTE_EQUALS',
      {
        type: 'ATTRIBUTE_EQUALS',
        attributeName: 'data-onboarding-state',
        expected: 'complete',
      },
    ],
    ['COUNT_AT_LEAST', { type: 'COUNT_AT_LEAST', minimumCount: 1 }],
  ] satisfies Array<
    [string, ProductExperienceCondition]
  >)('matches the declarative %s condition on visible elements', async (_, condition) => {
    element()

    expect(
      await evaluateProductRule(rule(condition), document, CLIENT_URL),
    ).toEqual({
      ruleId: 'onboarding-done',
      matchedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      ),
      origin: 'https://client.example',
      urlPathHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
  })

  it.each([
    'display',
    'visibility',
    'opacity',
    'rect',
  ] as const)('requires a visible element: rejects %s-hidden nodes', async (kind) => {
    const node = element()
    hide(node, kind)

    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }),
        document,
        CLIENT_URL,
      ),
    ).toBeNull()
  })

  it.each([
    { type: 'ELEMENT_EXISTS' },
    { type: 'TEXT_CONTAINS', expected: 'setup complete' },
    {
      type: 'ATTRIBUTE_EQUALS',
      attributeName: 'data-onboarding-state',
      expected: 'complete',
    },
    { type: 'COUNT_AT_LEAST', minimumCount: 1 },
  ] satisfies ProductExperienceCondition[])('never lets a hidden element satisfy $type', async (condition) => {
    const node = element()
    hide(node, 'display')

    expect(
      await evaluateProductRule(rule(condition), document, CLIENT_URL),
    ).toBeNull()
  })

  it('counts only visible selector matches for COUNT_AT_LEAST', async () => {
    element()
    element()
    hide(element(), 'visibility')

    expect(
      await evaluateProductRule(
        rule({ type: 'COUNT_AT_LEAST', minimumCount: 2 }),
        document,
        CLIENT_URL,
      ),
    ).not.toBeNull()
    expect(
      await evaluateProductRule(
        rule({ type: 'COUNT_AT_LEAST', minimumCount: 3 }),
        document,
        CLIENT_URL,
      ),
    ).toBeNull()
  })

  it.each([
    ['$128,430', 100000],
    ['100K', 100000],
    ['1.2M', 1000000],
    ['10万', 100000],
  ])('matches numeric threshold text %s', async (text, minimumValue) => {
    element({ id: 'trading-volume' }, text)

    expect(
      await evaluateProductRule(
        rule(
          {
            type: 'NUMERIC_AT_LEAST',
            minimumValue,
          },
          { selector: '#trading-volume' },
        ),
        document,
        CLIENT_URL,
      ),
    ).not.toBeNull()
  })

  it('rejects numeric threshold text below the configured value', async () => {
    element({ id: 'trading-volume' }, '$99,999')

    expect(
      await evaluateProductRule(
        rule(
          {
            type: 'NUMERIC_AT_LEAST',
            minimumValue: 100000,
          },
          { selector: '#trading-volume' },
        ),
        document,
        CLIENT_URL,
      ),
    ).toBeNull()
  })

  it.each([
    ['class', 'complete'],
    ['aria-current', 'step'],
    ['data-state', 'done'],
  ])('allows the safe %s attribute family', async (attributeName, expected) => {
    element({
      'data-onboarding-state': 'complete',
      [attributeName]: expected,
    })

    expect(
      await evaluateProductRule(
        rule({ type: 'ATTRIBUTE_EQUALS', attributeName, expected }),
        document,
        CLIENT_URL,
      ),
    ).not.toBeNull()
  })

  it.each([
    'value',
    'style',
    'src',
    'href',
    'onclick',
    'ARIA-current',
  ])('rejects the forbidden %s attribute without reading it', async (attributeName) => {
    element({
      'data-onboarding-state': 'complete',
      [attributeName]: 'secret',
    })

    expect(
      await evaluateProductRule(
        rule({
          type: 'ATTRIBUTE_EQUALS',
          attributeName,
          expected: 'secret',
        }),
        document,
        CLIENT_URL,
      ),
    ).toBeNull()
  })

  it('matches HTTPS origin and pathname glob but ignores query/hash evidence', async () => {
    element()
    const first = await evaluateProductRule(
      rule({ type: 'ELEMENT_EXISTS' }),
      document,
      `${CLIENT_URL}?token=secret#private`,
    )
    const second = await evaluateProductRule(
      rule({ type: 'ELEMENT_EXISTS' }),
      document,
      `${CLIENT_URL}?different=yes#other`,
    )

    expect(first?.urlPathHash).toBe(second?.urlPathHash)
    expect(first?.origin).toBe('https://client.example')
    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }),
        document,
        'https://client.example/settings',
      ),
    ).toBeNull()
    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }),
        document,
        'https://other.example/onboarding/done',
      ),
    ).toBeNull()
  })

  it.each([
    ['localhost', 'http://localhost:3000/onboarding/*'],
    ['127.0.0.1', 'http://127.0.0.1:3000/onboarding/*'],
    ['[::1]', 'http://[::1]:3000/onboarding/*'],
  ])('accepts exact %s loopback HTTP for local verification', async (_, pattern) => {
    element()
    const href = pattern.replace('*', 'done')

    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }, { urlPattern: pattern }),
        document,
        href,
      ),
    ).not.toBeNull()
  })

  it.each([
    'http://client.example/onboarding/*',
    'http://localhost.evil.example/onboarding/*',
    'http://127.0.0.1.evil.example/onboarding/*',
    'http://127.1/onboarding/*',
    'http://2130706433/onboarding/*',
    'http://[0:0:0:0:0:0:0:1]/onboarding/*',
    'http://0.0.0.0/onboarding/*',
    'file:///onboarding/*',
    'data:text/html,onboarding/*',
    'chrome-extension://abc/onboarding/*',
  ])('rejects unsafe URL pattern %s', async (urlPattern) => {
    element()

    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }, { urlPattern }),
        document,
        CLIENT_URL,
      ),
    ).toBeNull()
  })

  it('can mirror the Backend production contract that never issues loopback HTTP rules', async () => {
    element()
    const urlPattern = 'http://localhost:3000/onboarding/*'

    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }, { urlPattern }),
        document,
        urlPattern.replace('*', 'done'),
        { allowLoopbackHttp: false },
      ),
    ).toBeNull()
  })

  it.each([
    'https://client.example/onboarding/[a-z]+',
    'https://client.example/onboarding/(done)',
    'https://*.example/onboarding/*',
    'https://client.example/onboarding/*?secret=value',
  ])('rejects regex, hostname wildcard, or query syntax in %s', async (urlPattern) => {
    element()

    expect(
      await evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }, { urlPattern }),
        document,
        CLIENT_URL,
      ),
    ).toBeNull()
  })

  it('catches an invalid selector as a safe non-match', async () => {
    element()

    await expect(
      evaluateProductRule(
        rule({ type: 'ELEMENT_EXISTS' }, { selector: 'div[' }),
        document,
        CLIENT_URL,
      ),
    ).resolves.toBeNull()
  })

  it('returns metadata only, never DOM text, selector, or attributes', async () => {
    element(
      {
        'data-onboarding-state': 'complete',
        'data-private': 'private-attribute-value',
      },
      'private page body text',
    )

    const match = await evaluateProductRule(
      rule({ type: 'TEXT_CONTAINS', expected: 'private page' }),
      document,
      CLIENT_URL,
    )
    const serialized = JSON.stringify(match)

    expect(Object.keys(match ?? {}).sort()).toEqual([
      'matchedAt',
      'origin',
      'ruleId',
      'urlPathHash',
    ])
    expect(serialized).not.toContain('private page body text')
    expect(serialized).not.toContain('private-attribute-value')
    expect(serialized).not.toContain('[data-onboarding-state]')
    expect(serialized).not.toContain('Complete onboarding')
  })
})
