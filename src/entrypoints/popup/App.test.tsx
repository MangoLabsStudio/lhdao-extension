import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import type { ProductExperienceControllerState } from '@/lib/product-experience-controller'
import type { MsgResponse } from '@/types/messages'
import { App } from './App'

const PRODUCT_TITLE = 'Complete the Acme onboarding'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const POPUP_DATA: Extract<MsgResponse, { type: 'popup-data' }> = {
  type: 'popup-data',
  hasToken: true,
  tokenMasked: 'lhdao_pk_••••8f3d',
  profile: null,
  taskCount: 2,
  tweetCount: 1,
  lastSyncAt: null,
  lastSyncError: null,
  lastSyncHttpStatus: null,
}

function productState(
  status: ProductExperienceControllerState['status'],
  overrides: Partial<ProductExperienceControllerState> = {},
): ProductExperienceControllerState {
  return {
    campaignId: 'campaign-product-001',
    title: PRODUCT_TITLE,
    status,
    matchedRuleIds: [],
    totalRuleCount: 2,
    authorizationRequired: status === 'ready' || status === 'reauthorize',
    currentOriginAllowed: !['ready', 'origin-mismatch', 'reauthorize'].includes(
      status,
    ),
    error: null,
    ...overrides,
  }
}

interface PopupHarness {
  container: HTMLElement
  requests: unknown[]
  setProductState(state: ProductExperienceControllerState): void
  broadcastStateChanged(): Promise<void>
}

let root: Root | null = null

async function renderPopup(
  initialState: ProductExperienceControllerState,
): Promise<PopupHarness> {
  let currentState = initialState
  const requests: unknown[] = []

  fakeBrowser.runtime.onMessage.addListener(async (message: unknown) => {
    requests.push(structuredClone(message))
    if (!message || typeof message !== 'object' || !('type' in message)) {
      return { type: 'ack' }
    }
    switch (message.type) {
      case 'get-popup-data':
        return POPUP_DATA
      case 'get-pairing-status':
        return { type: 'pairing-status-result', state: { kind: 'idle' } }
      case 'get-product-experience-state':
        return { type: 'product-experience-state-result', state: currentState }
      case 'start-product-experience':
        return { type: 'product-experience-state-result', state: currentState }
      default:
        return { type: 'ack' }
    }
  })

  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<App />))
  await vi.waitFor(() => {
    expect(requests).toContainEqual({ type: 'get-product-experience-state' })
  })

  return {
    container,
    requests,
    setProductState(state) {
      currentState = state
    },
    async broadcastStateChanged() {
      await act(async () => {
        await fakeBrowser.runtime.onMessage.trigger(
          { type: 'product-experience-state-changed' },
          {},
        )
      })
    },
  }
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

describe('product experience popup', () => {
  beforeEach(() => {
    fakeBrowser.reset()
    document.body.replaceChildren()
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it.each([
    ['ready', '准备验证'],
    ['authorizing', '正在授权'],
    ['observing', '正在检查'],
    ['submitting', '正在提交'],
    ['verified', '验证通过'],
    ['expired', '验证已过期'],
    ['origin-mismatch', '当前网站不匹配'],
    ['reauthorize', '需要授权'],
    ['error', '验证遇到问题'],
  ] as const)('renders the %s state without exposing private proof data', async (status, label) => {
    const taintedState = {
      ...productState(status),
      selector: '#private-account',
      ticket: 'private-ticket',
      macKey: 'private-mac',
      matchedText: 'private page copy',
    } as ProductExperienceControllerState
    const { container } = await renderPopup(taintedState)

    await vi.waitFor(() => expect(container.textContent).toContain(label))
    expect(container.textContent).toContain(PRODUCT_TITLE)
    expect(container.textContent).not.toContain('#private-account')
    expect(container.textContent).not.toContain('private-ticket')
    expect(container.textContent).not.toContain('private-mac')
    expect(container.textContent).not.toContain('private page copy')
  })

  it('starts only through the explicit active-tab authorization message', async () => {
    const { container, requests } = await renderPopup(productState('ready'))
    await vi.waitFor(() => expect(container.textContent).toContain('准备验证'))
    requests.splice(0)

    await act(async () => {
      findButton(container, '开始验证').click()
    })

    await vi.waitFor(() => {
      expect(requests).toContainEqual({ type: 'start-product-experience' })
    })
    expect(
      requests.filter(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'start-product-experience',
      ),
    ).toEqual([{ type: 'start-product-experience' }])
  })

  it('refreshes from the controller broadcast and retains safe progress on reauthorization', async () => {
    const harness = await renderPopup(productState('observing'))
    await vi.waitFor(() =>
      expect(harness.container.textContent).toContain('正在检查'),
    )

    harness.setProductState(
      productState('reauthorize', {
        matchedRuleIds: ['account-created'],
        authorizationRequired: true,
        currentOriginAllowed: true,
        error: 'AUTHORIZATION_REQUIRED',
      }),
    )
    await harness.broadcastStateChanged()

    await vi.waitFor(() => {
      expect(harness.container.textContent).toContain('需要授权')
      expect(harness.container.textContent).toContain('1 / 2')
    })
    expect(findButton(harness.container, '重新授权')).toBeTruthy()
    expect(harness.container.textContent).toContain(
      '只在本次授权的当前网站读取 Buyer 配置的完成标记',
    )
  })

  it.each([
    [
      'observing',
      [
        {
          ruleId: 'deposit',
          title: '入金余额',
          status: 'PENDING',
          current: null,
          target: 100,
          unit: 'USDT',
        },
      ],
      '等待证明',
    ],
    [
      'submitting',
      [
        {
          ruleId: 'deposit',
          title: '入金余额',
          status: 'PENDING',
          current: null,
          target: 100,
          unit: 'USDT',
        },
      ],
      '正在生成证明',
    ],
    [
      'submitting',
      [
        {
          ruleId: 'deposit',
          title: '入金余额',
          status: 'SUBMITTED',
          current: null,
          target: 100,
          unit: 'USDT',
        },
      ],
      '证明已提交，等待后端确认',
    ],
  ] as const)('renders the backend zkTLS %s state as %s', async (status, zkTlsProgress, label) => {
    const { container } = await renderPopup(
      productState(status, { zkTlsProgress: [...zkTlsProgress] }),
    )

    await vi.waitFor(() => expect(container.textContent).toContain(label))
  })

  it('renders backend partial values and a stable authorization label', async () => {
    const harness = await renderPopup(
      productState('observing', {
        totalRuleCount: 1,
        zkTlsProgress: [
          {
            ruleId: 'trading-days',
            title: '近 7 天达标交易日',
            status: 'PARTIAL',
            current: 2,
            target: 3,
            unit: '天',
          },
        ],
      }),
    )
    await vi.waitFor(() => {
      expect(harness.container.textContent).toContain('部分完成')
      expect(harness.container.textContent).toContain('2 / 3 天')
    })

    harness.setProductState(productState('reauthorize'))
    await harness.broadcastStateChanged()
    await vi.waitFor(() =>
      expect(harness.container.textContent).toContain('需要授权'),
    )
  })

  it('shows verified only for the authoritative verified state', async () => {
    const harness = await renderPopup(
      productState('submitting', {
        matchedRuleIds: ['deposit'],
        totalRuleCount: 2,
        zkTlsProgress: [
          {
            ruleId: 'deposit',
            title: '入金余额',
            status: 'VERIFIED',
            current: 120,
            target: 100,
            unit: 'USDT',
          },
          {
            ruleId: 'kyc',
            title: 'KYC',
            status: 'SUBMITTED',
            current: null,
            target: true,
            unit: null,
          },
        ],
      }),
    )
    await vi.waitFor(() =>
      expect(harness.container.textContent).toContain(
        '证明已提交，等待后端确认',
      ),
    )
    expect(
      harness.container.querySelector('[data-testid="product-verified-badge"]'),
    ).toBeNull()

    harness.setProductState(productState('verified'))
    await harness.broadcastStateChanged()
    await vi.waitFor(() =>
      expect(
        harness.container.querySelector(
          '[data-testid="product-verified-badge"]',
        ),
      ).not.toBeNull(),
    )
    expect(harness.container.textContent).toContain('验证通过')
  })

  it('offers a stable retry action after a retryable proof failure', async () => {
    const { container } = await renderPopup(
      productState('observing', {
        error: 'VERIFICATION_FAILED',
        zkTlsProgress: [
          {
            ruleId: 'deposit',
            title: '入金余额',
            status: 'PENDING',
            current: null,
            target: 100,
            unit: 'USDT',
          },
        ],
      }),
    )

    await vi.waitFor(() =>
      expect(findButton(container, '重试证明')).toBeTruthy(),
    )
  })
})
