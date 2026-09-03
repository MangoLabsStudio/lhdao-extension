import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { ProductExperienceCard } from '@/components/product-experience/ProductExperienceCard'
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

// Exact public shapes returned by ProductExperienceController.expiredState,
// errorState and stateFromSession. Keep these fixtures aligned with the
// controller boundary instead of inventing UI-only status combinations.
const TERMINAL_EXPIRED_STATE = {
  campaignId: 'campaign-product-001',
  title: PRODUCT_TITLE,
  status: 'expired',
  matchedRuleIds: [],
  totalRuleCount: 0,
  authorizationRequired: true,
  currentOriginAllowed: false,
  error: 'SESSION_EXPIRED',
} satisfies ProductExperienceControllerState

const TERMINAL_ERROR_STATE = {
  campaignId: 'campaign-product-001',
  title: PRODUCT_TITLE,
  status: 'error',
  matchedRuleIds: [],
  totalRuleCount: 0,
  authorizationRequired: false,
  currentOriginAllowed: false,
  error: 'VERIFICATION_FAILED',
} satisfies ProductExperienceControllerState

const ORIGIN_MISMATCH_SESSION_STATE = {
  campaignId: 'campaign-product-001',
  title: PRODUCT_TITLE,
  status: 'reauthorize',
  matchedRuleIds: [],
  totalRuleCount: 1,
  authorizationRequired: true,
  currentOriginAllowed: false,
  error: 'ORIGIN_NOT_ALLOWED',
  zkTlsProgress: [],
} satisfies ProductExperienceControllerState

const PERMISSION_DENIED_SESSION_STATE = {
  ...ORIGIN_MISMATCH_SESSION_STATE,
  authorizationRequired: true,
  error: 'AUTHORIZATION_REQUIRED',
} satisfies ProductExperienceControllerState

interface PopupHarness {
  container: HTMLElement
  requests: unknown[]
  setProductState(state: ProductExperienceControllerState): void
  broadcastStateChanged(): Promise<void>
}

let root: Root | null = null

async function renderPopup(
  initialState: ProductExperienceControllerState,
  popupData: Extract<MsgResponse, { type: 'popup-data' }> = POPUP_DATA,
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
        return popupData
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

  it('shows immediate page-check feedback while the start action is running', async () => {
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <ProductExperienceCard
          state={productState('observing')}
          busy
          onStart={() => undefined}
        />,
      ),
    )

    expect(container.textContent).toContain('正在检查页面')
    expect(container.textContent).toContain('正在注入页面监听并检查规则')
  })

  it('shows terminal no as a business result and retries only the selected paused condition', async () => {
    const { container, requests } = await renderPopup(
      productState('observing', {
        zkTlsProgress: [
          {
            ruleId: 'rule-a',
            title: 'Balance',
            status: 'VERIFIED_NO',
            current: 2,
            target: 3,
            actual: 2,
            required: 3,
            comparator: 'GTE',
            unit: null,
          },
        ],
        zkTlsConditions: [
          {
            ruleId: 'rule-a',
            status: 'verified_no',
            code: null,
            stage: null,
            correlationId: null,
          },
          {
            ruleId: 'rule-b',
            status: 'action_required',
            code: 'NO_REQUEST_OBSERVED',
            stage: 'capture-failed',
            correlationId: 'safe-correlation',
          },
        ],
      }),
    )
    expect(container.textContent).toContain('未满足')
    expect(container.textContent).toContain('实际 2')
    expect(container.textContent).toContain('要求 GTE 3')
    expect(container.textContent).toContain('NO_REQUEST_OBSERVED')
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === '继续此条件',
    )
    expect(button).toBeDefined()
    await act(async () => button?.click())
    expect(requests).toContainEqual({
      type: 'retry-product-experience-rule',
      campaignId: 'campaign-product-001',
      ruleId: 'rule-b',
    })
  })

  it('closes mixed yes/no without a proof retry button', async () => {
    const { container } = await renderPopup(
      productState('observing', { zkTlsFinished: true, zkTlsProgress: [] }),
    )
    expect(container.textContent).toContain('验证完成，部分条件不满足')
    expect(container.textContent).not.toContain('继续证明')
    expect(container.textContent).not.toContain('证明失败')
  })

  it('shows captured proof stages and exact safe failure details', async () => {
    const { container } = await renderPopup(
      productState('observing', {
        error: 'VERIFICATION_FAILED',
        zkTlsFailureCode: 'PROVER_FAILED',
        zkTlsProgress: [],
        zkTlsDiagnostic: {
          correlationId: 'proof-20260901',
          startedAt: 100,
          updatedAt: 300,
          events: [
            {
              at: 100,
              stage: 'rule-evaluated',
              status: 'passed',
              details: {
                selector: '#portfolio',
                matchedElementCount: 1,
                conditionMatched: true,
              },
            },
            {
              at: 200,
              stage: 'request-captured',
              status: 'passed',
              details: {
                method: 'GET',
                targetOrigin: 'https://archive.prod.nado.xyz',
                request: { path: '/v1/history?account=0x1234' },
                responseContentEncoding: 'gzip',
              },
            },
            {
              at: 300,
              stage: 'verifier-session-registered:failed',
              status: 'failed',
              error: {
                name: 'TypeError',
                message: 'WebSocket connection refused',
                code: 'ERR_CONNECTION_REFUSED',
              },
            },
          ],
        },
      }),
    )

    await vi.waitFor(() => {
      expect(container.textContent).toContain('诊断记录')
      expect(container.textContent).toContain('request-captured')
      expect(container.textContent).toContain('/v1/history?account=0x1234')
      expect(container.textContent).toContain('gzip')
      expect(container.textContent).toContain('WebSocket connection refused')
      expect(container.textContent).toContain('ERR_CONNECTION_REFUSED')
    })
    expect(
      container.querySelector<HTMLDetailsElement>(
        '[data-testid="zktls-diagnostics"]',
      )?.open,
    ).toBe(true)
  })

  it('copies the complete safe diagnostic record', async () => {
    const writeText = vi.fn(async (_value: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const { container } = await renderPopup(
      productState('observing', {
        zkTlsProgress: [],
        zkTlsDiagnostic: {
          correlationId: 'copy-proof-1',
          startedAt: 100,
          updatedAt: 100,
          events: [
            {
              at: 100,
              stage: 'request-captured',
              status: 'passed',
              details: { path: '/v1/history' },
            },
          ],
        },
      }),
    )

    await act(async () => findButton(container, '复制诊断').click())

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText.mock.calls[0]?.[0]).toContain('copy-proof-1')
    expect(writeText.mock.calls[0]?.[0]).toContain('request-captured')
    expect(writeText.mock.calls[0]?.[0]).toContain('/v1/history')
    expect(container.textContent).toContain('已复制')
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

  it('continues a backend PARTIAL proof through the existing start action', async () => {
    const harness = await renderPopup(
      productState('observing', {
        totalRuleCount: 1,
        zkTlsProgress: [
          {
            ruleId: 'gzip-proof',
            title: '验证 gzip 响应',
            status: 'PARTIAL',
            current: true,
            target: true,
            unit: null,
          },
        ],
      }),
    )

    const button = findButton(harness.container, '继续证明')
    await act(async () => button.click())

    await vi.waitFor(() => {
      expect(
        harness.requests.filter(
          (request) =>
            request &&
            typeof request === 'object' &&
            'type' in request &&
            request.type === 'start-product-experience',
        ),
      ).toEqual([{ type: 'start-product-experience' }])
    })
    expect(harness.container.textContent).not.toContain('重试证明')
  })

  it('continues a backend PENDING next-stage proof through the existing start action', async () => {
    const harness = await renderPopup(
      productState('observing', {
        zkTlsProgress: [
          {
            ruleId: 'gzip-proof',
            title: '验证 gzip 响应',
            status: 'PENDING',
            current: null,
            target: true,
            unit: null,
          },
        ],
      }),
    )

    await vi.waitFor(() =>
      expect(harness.container.textContent).toContain('等待证明'),
    )
    const button = findButton(harness.container, '继续证明')
    await act(async () => button.click())

    await vi.waitFor(() => {
      expect(
        harness.requests.filter(
          (request) =>
            request &&
            typeof request === 'object' &&
            'type' in request &&
            request.type === 'start-product-experience',
        ),
      ).toEqual([{ type: 'start-product-experience' }])
    })
  })

  it('continues an observing zkTLS session before progress is loaded', async () => {
    const harness = await renderPopup(
      productState('observing', { zkTlsProgress: [] }),
    )

    await act(async () => findButton(harness.container, '继续证明').click())

    await vi.waitFor(() => {
      expect(
        harness.requests.filter(
          (request) =>
            request &&
            typeof request === 'object' &&
            'type' in request &&
            request.type === 'start-product-experience',
        ),
      ).toEqual([{ type: 'start-product-experience' }])
    })
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
        zkTlsFailureCode: 'PROVER_TIMEOUT',
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
    expect(container.textContent).toContain('错误码：PROVER_TIMEOUT')
  })

  it('does not invent a zkTLS diagnostic for unrelated failures', async () => {
    const { container } = await renderPopup(PERMISSION_DENIED_SESSION_STATE)
    await vi.waitFor(() => expect(container.textContent).toContain('需要授权'))
    expect(container.textContent).not.toContain('错误码：')
  })

  it.each([
    ['expired', TERMINAL_EXPIRED_STATE, '验证已过期'],
    ['error', TERMINAL_ERROR_STATE, '验证遇到问题'],
  ] as const)('does not offer retry after the controller finishes into %s', async (_name, state, label) => {
    const { container } = await renderPopup(state)
    await vi.waitFor(() => expect(container.textContent).toContain(label))
    expect(container.textContent).not.toContain('重试证明')
  })

  it('distinguishes origin mismatch from permission reauthorization', async () => {
    const harness = await renderPopup(ORIGIN_MISMATCH_SESSION_STATE)
    await vi.waitFor(() => {
      expect(harness.container.textContent).toContain('当前网站不匹配')
      expect(findButton(harness.container, '检查当前网站')).toBeTruthy()
      expect(
        harness.container.querySelector('[data-testid="product-origin-status"]')
          ?.textContent,
      ).toBe('当前网站不匹配')
    })
    expect(harness.container.textContent).not.toContain('重新授权')

    harness.setProductState(PERMISSION_DENIED_SESSION_STATE)
    await harness.broadcastStateChanged()
    await vi.waitFor(() => {
      expect(harness.container.textContent).toContain('需要授权')
      expect(findButton(harness.container, '重新授权')).toBeTruthy()
    })
  })

  it('labels every backend progress status before displaying its value', async () => {
    const { container } = await renderPopup(
      productState('observing', {
        zkTlsProgress: [
          {
            ruleId: 'verified',
            title: '入金余额',
            status: 'VERIFIED',
            current: 120,
            target: 100,
            unit: 'USDT',
          },
          {
            ruleId: 'partial',
            title: '达标交易日',
            status: 'PARTIAL',
            current: 2,
            target: 3,
            unit: null,
          },
          {
            ruleId: 'submitted',
            title: 'KYC',
            status: 'SUBMITTED',
            current: true,
            target: true,
            unit: null,
          },
          {
            ruleId: 'window',
            title: '完整周期',
            status: 'INSUFFICIENT_DATA',
            current: null,
            target: null,
            unit: null,
          },
          {
            ruleId: 'pending',
            title: '账户状态',
            status: 'PENDING',
            current: 1,
            target: 1,
            unit: null,
          },
        ],
      }),
    )

    await vi.waitFor(() => {
      expect(container.textContent).toContain('已完成（120 / 100 USDT）')
      expect(container.textContent).toContain('部分完成（2 / 3）')
      expect(container.textContent).toContain('数据范围不足')
      expect(container.textContent).toContain('已提交，等待后端确认')
      expect(container.textContent).toContain('等待证明')
    })
  })

  it('announces async status and sanitizes control characters for display', async () => {
    const { container } = await renderPopup(
      productState('submitting', {
        zkTlsProgress: [
          {
            ruleId: 'deposit',
            title:
              '入金\u0000余额\n超长\u202e标题\u2066隔离\u200f文本\u061c'.repeat(
                20,
              ),
            status: 'SUBMITTED',
            current: null,
            target: 100,
            unit: 'USDT',
          },
        ],
      }),
    )

    await vi.waitFor(() => {
      const status = container.querySelector('[role="status"]')
      expect(status?.getAttribute('aria-live')).toBe('polite')
      expect(
        Array.from(container.textContent ?? '').every((character) => {
          const code = character.charCodeAt(0)
          return (
            code > 31 &&
            (code < 127 || code > 159) &&
            code !== 0x061c &&
            code !== 0x200e &&
            code !== 0x200f &&
            (code < 0x202a || code > 0x202e) &&
            (code < 0x2066 || code > 0x2069)
          )
        }),
      ).toBe(true)
    })
    expect(container.querySelector('li span')?.className).toContain('max-w-')
  })

  it('reconnects a token that is not bound to the current browser', async () => {
    const { container, requests } = await renderPopup(productState('ready'), {
      ...POPUP_DATA,
      lastSyncError: 'PLUGIN_DEVICE_DENIED: 你没有权限执行此操作。',
      lastSyncHttpStatus: 200,
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain('设备授权已失效')
      expect(container.textContent).toContain('此 Token 未绑定当前浏览器')
    })

    await act(async () => findButton(container, '重新连接').click())

    await vi.waitFor(() => {
      expect(requests).toContainEqual({ type: 'start-pairing' })
    })
  })
})
