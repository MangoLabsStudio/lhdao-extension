import { describe, expect, it } from 'vitest'
import {
  PRODUCT_EXPERIENCE_CAPABILITY,
  PRODUCT_EXPERIENCE_PAGE_CHANNEL,
  parseProductExperiencePageRequest,
  projectPublicProductExperienceState,
} from '../product-experience-task-bridge'

const LIGHTHOUSE_ORIGIN = 'https://app.lhdao.top'
const pageWindow = window

function messageEvent(
  data: unknown,
  overrides: Partial<MessageEventInit> = {},
) {
  return new MessageEvent('message', {
    data,
    origin: LIGHTHOUSE_ORIGIN,
    source: pageWindow,
    ...overrides,
  })
}

function saveRequest(overrides: Record<string, unknown> = {}) {
  return {
    channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
    type: 'save-product-experience-task',
    correlationId: 'request-12345678',
    task: {
      campaignId: 'campaign-product-001',
      ticketKind: 'PARTICIPANT',
      configVersion: 3,
      title: 'Try the onboarding flow',
      savedAt: 1_783_936_800_000,
    },
    ...overrides,
  }
}

describe('parseProductExperiencePageRequest', () => {
  const discoveryRequests = [
    { type: 'start-discovery', targetUrl: 'https://app.example.com' },
    { type: 'start-discovery', targetUrl: 'https://app.example.com/account' },
    { type: 'stop-discovery', sessionId: 'discovery-12345678' },
    { type: 'get-discovery-snapshot', sessionId: 'discovery-12345678' },
  ]

  it.each(
    discoveryRequests,
  )('accepts exact discovery request $type', (fields) => {
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      correlationId: 'request-12345678',
      ...fields,
    }
    expect(
      parseProductExperiencePageRequest(
        messageEvent(request),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toEqual(request)
  })

  it.each(
    discoveryRequests,
  )('rejects unsafe discovery request $type', (fields) => {
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      correlationId: 'request-12345678',
      ...fields,
    }
    for (const extra of [
      { tabId: 4 },
      { ownerTabId: 4 },
      { body: 'secret' },
      { headers: {} },
      { correlationId: '' },
    ]) {
      expect(
        parseProductExperiencePageRequest(
          messageEvent({ ...request, ...extra }),
          pageWindow,
          LIGHTHOUSE_ORIGIN,
        ),
      ).toBeNull()
    }
    expect(
      parseProductExperiencePageRequest(
        messageEvent(request, { source: null }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
    expect(
      parseProductExperiencePageRequest(
        messageEvent(request, { origin: 'https://evil.example' }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it.each(
    discoveryRequests,
  )('rejects discovery accessors without reading them: $type', (fields) => {
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      correlationId: 'request-12345678',
      ...fields,
    }
    for (const field of Object.keys(request)) {
      let reads = 0
      const candidate = { ...request }
      Object.defineProperty(candidate, field, {
        enumerable: true,
        get() {
          reads += 1
          return reads === 1
            ? request[field as keyof typeof request]
            : 'javascript:alert(1)'
        },
      })
      expect(
        parseProductExperiencePageRequest(
          messageEvent(candidate),
          pageWindow,
          LIGHTHOUSE_ORIGIN,
        ),
      ).toBeNull()
      expect(reads).toBe(0)
    }
  })

  it('rejects a targetUrl getter that changes from HTTPS to javascript without invoking it', () => {
    let reads = 0
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      correlationId: 'request-12345678',
      type: 'start-discovery',
      get targetUrl() {
        reads += 1
        return reads === 1 ? 'https://app.example.com/' : 'javascript:alert(1)'
      },
    }
    const parsed = parseProductExperiencePageRequest(
      messageEvent(request),
      pageWindow,
      LIGHTHOUSE_ORIGIN,
    )
    expect(parsed).toBeNull()
    expect(reads).toBe(0)
  })

  it.each(
    discoveryRequests,
  )('rejects discovery hidden and symbol keys: $type', (fields) => {
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      correlationId: 'request-12345678',
      ...fields,
    }
    for (const key of ['tabId', 'ownerTabId', Symbol('tabId')]) {
      const candidate = Object.defineProperty({ ...request }, key, {
        value: 4,
        enumerable: false,
      })
      expect(
        parseProductExperiencePageRequest(
          messageEvent(candidate),
          pageWindow,
          LIGHTHOUSE_ORIGIN,
        ),
      ).toBeNull()
    }
    const candidate = Object.defineProperty({ ...request }, 'type', {
      value: request.type,
      enumerable: false,
    })
    expect(
      parseProductExperiencePageRequest(
        messageEvent(candidate),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it.each(
    discoveryRequests,
  )('rejects discovery proxies and exotic prototypes: $type', (fields) => {
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      correlationId: 'request-12345678',
      ...fields,
    }
    const { proxy, revoke } = Proxy.revocable(request, {})
    revoke()
    for (const candidate of [
      new Proxy(request, {}),
      proxy,
      Object.setPrototypeOf({ ...request }, { tabId: 4 }),
    ]) {
      expect(
        parseProductExperiencePageRequest(
          messageEvent(candidate),
          pageWindow,
          LIGHTHOUSE_ORIGIN,
        ),
      ).toBeNull()
    }
  })

  it.each([
    '',
    'http://app.example.com',
    'javascript:alert(1)',
    'https://user:pass@app.example.com',
    'https://app.example.com/#secret',
    'https://app.example.com/\npath',
    `https://app.example.com/${'x'.repeat(2048)}`,
  ])('rejects invalid discovery target %s', (targetUrl) => {
    expect(
      parseProductExperiencePageRequest(
        messageEvent({
          channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
          correlationId: 'request-12345678',
          type: 'start-discovery',
          targetUrl,
        }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it.each([
    '',
    'space session',
    'x'.repeat(129),
  ])('rejects invalid discovery session %s', (sessionId) => {
    for (const type of ['stop-discovery', 'get-discovery-snapshot']) {
      expect(
        parseProductExperiencePageRequest(
          messageEvent({
            channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
            correlationId: 'request-12345678',
            type,
            sessionId,
          }),
          pageWindow,
          LIGHTHOUSE_ORIGIN,
        ),
      ).toBeNull()
    }
  })

  it('accepts a strictly shaped task-save request from the Lighthouse window', () => {
    expect(
      parseProductExperiencePageRequest(
        messageEvent(saveRequest()),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toEqual(saveRequest())
  })

  it('accepts a campaign-correlated public-state query', () => {
    const request = {
      channel: PRODUCT_EXPERIENCE_PAGE_CHANNEL,
      type: 'get-public-product-experience-state',
      correlationId: 'request-abcdefgh',
      campaignId: 'campaign-product-001',
    }

    expect(
      parseProductExperiencePageRequest(
        messageEvent(request),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toEqual(request)
  })

  it('rejects another source window or origin', () => {
    expect(
      parseProductExperiencePageRequest(
        messageEvent(saveRequest(), { source: null }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
    expect(
      parseProductExperiencePageRequest(
        messageEvent(saveRequest(), { origin: 'https://evil.example' }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it.each([
    '',
    'short',
    'contains spaces 123',
    'x'.repeat(129),
  ])('rejects an invalid correlation ID: %s', (correlationId) => {
    expect(
      parseProductExperiencePageRequest(
        messageEvent(saveRequest({ correlationId })),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it.each([
    ['unknown ticket kind', { ticketKind: 'UNSUPPORTED' }],
    ['zero config version', { configVersion: 0 }],
    ['fractional config version', { configVersion: 1.5 }],
    ['oversized campaign ID', { campaignId: 'c'.repeat(129) }],
    ['oversized title', { title: 't'.repeat(257) }],
    ['invalid savedAt', { savedAt: Number.NaN }],
  ])('rejects %s', (_name, taskChange) => {
    const valid = saveRequest()
    expect(
      parseProductExperiencePageRequest(
        messageEvent({
          ...valid,
          task: { ...(valid.task as object), ...taskChange },
        }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it.each([
    ['selector', '#account'],
    ['rules', [{ id: 'private-rule' }]],
    ['script', 'document.cookie'],
    ['url', 'https://client.example/private'],
    ['ticket', 'private-ticket'],
    ['macKey', 'private-mac'],
  ])('rejects a task carrying the forbidden %s field', (field, value) => {
    const valid = saveRequest()
    expect(
      parseProductExperiencePageRequest(
        messageEvent({
          ...valid,
          task: { ...(valid.task as object), [field]: value },
        }),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })

  it('rejects unknown request modes and extra top-level data', () => {
    expect(
      parseProductExperiencePageRequest(
        messageEvent(saveRequest({ type: 'run-product-script' })),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
    expect(
      parseProductExperiencePageRequest(
        messageEvent(saveRequest({ ticket: 'private-ticket' })),
        pageWindow,
        LIGHTHOUSE_ORIGIN,
      ),
    ).toBeNull()
  })
})

describe('projectPublicProductExperienceState', () => {
  const internalState = {
    campaignId: 'campaign-product-001',
    status: 'observing' as const,
    matchedRuleIds: ['rule-a', 'rule-b'],
    totalRuleCount: 3,
    authorizationRequired: false,
    currentOriginAllowed: true,
    error: null,
    sessionId: 'private-session',
    tabId: 42,
    ticket: 'private-ticket',
    macKey: 'private-mac',
    rules: [{ id: 'rule-a', selector: '#private' }],
    currentUrl: 'https://client.example/private?secret=yes',
  }

  it('returns only the explicit campaign progress projection', () => {
    const projected = projectPublicProductExperienceState(
      'campaign-product-001',
      internalState,
      '0.2.0',
    )

    expect(projected).toEqual({
      campaignId: 'campaign-product-001',
      status: 'observing',
      matchedRuleIds: ['rule-a', 'rule-b'],
      totalRuleCount: 3,
      authorizationRequired: false,
      currentOriginAllowed: true,
      version: '0.2.0',
      capabilities: [PRODUCT_EXPERIENCE_CAPABILITY],
      error: null,
    })
    expect(Object.keys(projected).sort()).toEqual([
      'authorizationRequired',
      'campaignId',
      'capabilities',
      'currentOriginAllowed',
      'error',
      'matchedRuleIds',
      'status',
      'totalRuleCount',
      'version',
    ])

    const serialized = JSON.stringify(projected)
    for (const secret of [
      'private-session',
      'private-ticket',
      'private-mac',
      '#private',
      'client.example',
      'secret=yes',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('returns idle for a different campaign without leaking active progress', () => {
    expect(
      projectPublicProductExperienceState(
        'another-campaign',
        internalState,
        '0.2.0',
      ),
    ).toEqual({
      campaignId: 'another-campaign',
      status: 'idle',
      matchedRuleIds: [],
      totalRuleCount: 0,
      authorizationRequired: false,
      currentOriginAllowed: false,
      version: '0.2.0',
      capabilities: [PRODUCT_EXPERIENCE_CAPABILITY],
      error: null,
    })
  })

  it('deduplicates and bounds public rule IDs', () => {
    const projected = projectPublicProductExperienceState(
      'campaign-product-001',
      {
        ...internalState,
        matchedRuleIds: ['rule-a', 'rule-a', '', 'x'.repeat(129), 'rule-b'],
      },
      '0.2.0',
    )

    expect(projected.matchedRuleIds).toEqual(['rule-a', 'rule-b'])
  })
})
