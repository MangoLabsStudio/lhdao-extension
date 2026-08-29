import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { PromoteDialog } from './PromoteDialog'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
let container: HTMLElement
let requests: unknown[]
let promoteFailure: { code: string; message: string }
let previewResponse: () => unknown | Promise<unknown>
let promoteResponse: () => unknown | Promise<unknown>

const quote = {
  quoteId: 'quote-plugin-1',
  priceVersion: 'pilot-version-1',
  currency: 'LUX' as const,
  precision: 8,
  quotedAt: '2099-01-01T10:00:00.000Z',
  expiresAt: '2099-01-02T00:00:00.000Z',
  principal: '2.00000000',
  feeRate: '0.10000000',
  promotionFee: '0.20000000',
  totalCost: '2.20000000',
  lines: [
    {
      campaignIndex: 0,
      actionType: 'LIKE',
      tier: 'A',
      quantity: 5,
      pricingSource: 'PILOT',
      unitPrice: '0.40000000',
      principal: '2.00000000',
      todayPrice: '0.40000000',
      tomorrowExpectedPrice: '0.39000000',
      schedule: [
        { dayIndex: 0, unitPrice: '0.40000000' },
        { dayIndex: 1, unitPrice: '0.39000000' },
      ],
    },
  ],
}

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

describe('PromoteDialog device recovery', () => {
  beforeEach(() => {
    fakeBrowser.reset()
    requests = []
    promoteFailure = {
      code: 'PLUGIN_DEVICE_DENIED',
      message: 'PLUGIN_DEVICE_DENIED: 你没有权限执行此操作。',
    }
    previewResponse = () => ({
      type: 'promote-pricing-result',
      ok: true,
      quote,
    })
    promoteResponse = () => ({
      type: 'promote-result',
      ok: false,
      ...promoteFailure,
    })
    document.body.replaceChildren()
    localStorage.clear()
    localStorage.setItem(
      'lhdao:promote:last',
      JSON.stringify({
        actions: ['LIKE'],
        slots: { A: 5 },
        reinvest: false,
        reinvestCount: 3,
      }),
    )
    container = document.createElement('div')
    document.body.append(container)
    fakeBrowser.runtime.onMessage.addListener(async (message: unknown) => {
      requests.push(structuredClone(message))
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return { type: 'ack' }
      }
      if (message.type === 'get-balance') {
        return { type: 'balance-result', balance: 100 }
      }
      if (message.type === 'preview-promote-tweet-pricing') {
        return previewResponse()
      }
      if (message.type === 'promote-tweet') {
        return promoteResponse()
      }
      if (message.type === 'start-pairing') {
        return { type: 'pairing-started', ok: true, code: 'pair-code' }
      }
      return { type: 'ack' }
    })
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it('offers reconnect and never retries the promotion automatically', async () => {
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() =>
      expect(container.textContent).toContain('2.20000000 LUX'),
    )
    await act(async () => {
      const confirm = findButton('确认推广')
      confirm.click()
      confirm.click()
    })

    await vi.waitFor(() => {
      expect(container.textContent).toContain(
        '设备授权已失效，请重新连接后再推广。',
      )
    })
    await act(async () => findButton('重新连接').click())
    await vi.waitFor(() => {
      expect(requests).toContainEqual({ type: 'start-pairing' })
    })
    expect(
      requests.filter(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toHaveLength(1)
  })

  it('previews authoritative server money before explicit confirmation', async () => {
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())

    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        type: 'preview-promote-tweet-pricing',
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions: [{ actionType: 'LIKE', tierSlots: { A: 5 } }],
      })
      expect(container.textContent).toContain('2.20000000 LUX')
      expect(container.textContent).toContain('手续费 0.20000000 LUX')
      expect(container.textContent).toContain('今日 0.40000000')
      expect(container.textContent).toContain('明日预计 0.39000000')
      expect(container.textContent).toContain('第 1 日 0.39000000')
      expect(container.textContent).toContain('2099-01-02T00:00:00.000Z UTC')
    })
    expect(
      requests.some(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toBe(false)

    await act(async () => findButton('确认推广').click())
    await vi.waitFor(() => {
      expect(requests).toContainEqual({
        type: 'promote-tweet',
        tweetUrl: 'https://x.com/lighthouse/status/1',
        actions: [{ actionType: 'LIKE', tierSlots: { A: 5 } }],
        quoteId: 'quote-plugin-1',
        reinvestCount: 0,
      })
    })
  })

  it('clears a quote after tier edits and confirms only the refreshed quote', async () => {
    let previewCount = 0
    previewResponse = () => {
      previewCount += 1
      return {
        type: 'promote-pricing-result',
        ok: true,
        quote: { ...quote, quoteId: `quote-plugin-${previewCount}` },
      }
    }
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() => expect(previewCount).toBe(1))

    const input = container.querySelector('input[type="number"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    await act(async () => {
      const element = input as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(element, '6')
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(() => expect(previewCount).toBe(2))
    await act(async () => findButton('确认推广').click())
    await vi.waitFor(() => {
      expect(requests).toContainEqual(
        expect.objectContaining({
          type: 'promote-tweet',
          quoteId: 'quote-plugin-2',
        }),
      )
    })
  })

  it('shows an upgrade-required response without attempting another payment', async () => {
    promoteFailure = {
      code: 'PLUGIN_UPGRADE_REQUIRED',
      message: 'PLUGIN_UPGRADE_REQUIRED',
    }
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() =>
      expect(container.textContent).toContain('2.20000000 LUX'),
    )
    await act(async () => findButton('确认推广').click())
    await vi.waitFor(() => {
      expect(container.textContent).toContain('请升级后重试')
    })
    expect(
      requests.filter(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toHaveLength(1)
  })

  it('requires an explicit refresh after a stale submission and never auto-pays', async () => {
    let previewCount = 0
    previewResponse = () => {
      previewCount += 1
      return {
        type: 'promote-pricing-result',
        ok: true,
        quote: { ...quote, quoteId: `quote-plugin-${previewCount}` },
      }
    }
    promoteFailure = {
      code: 'ENGAGEMENT_PILOT_QUOTE_EXPIRED',
      message: 'ENGAGEMENT_PILOT_QUOTE_EXPIRED',
    }
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() => expect(previewCount).toBe(1))
    await act(async () => findButton('确认推广').click())
    await vi.waitFor(() => {
      expect(findButton('刷新报价')).toBeInstanceOf(HTMLButtonElement)
    })
    expect(previewCount).toBe(1)
    expect(
      requests.filter(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toHaveLength(1)

    await act(async () => findButton('刷新报价').click())
    await vi.waitFor(() => expect(previewCount).toBe(2))
    expect(
      requests.filter(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toHaveLength(1)
  })

  it('ignores an older preview response after the inputs change', async () => {
    let resolveFirst: ((value: unknown) => void) | undefined
    let previewCount = 0
    previewResponse = () => {
      previewCount += 1
      if (previewCount === 1) {
        return new Promise((resolve) => {
          resolveFirst = resolve
        })
      }
      return {
        type: 'promote-pricing-result',
        ok: true,
        quote: {
          ...quote,
          quoteId: 'quote-new',
          totalCost: '3.30000000',
        },
      }
    }
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() => expect(previewCount).toBe(1))
    const input = container.querySelector('input[type="number"]')
    expect(input).toBeInstanceOf(HTMLInputElement)
    await act(async () => {
      const element = input as HTMLInputElement
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        'value',
      )?.set?.call(element, '6')
      element.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await vi.waitFor(() =>
      expect(container.textContent).toContain('3.30000000 LUX'),
    )
    await act(async () => {
      resolveFirst?.({
        type: 'promote-pricing-result',
        ok: true,
        quote: { ...quote, quoteId: 'quote-old' },
      })
      await Promise.resolve()
    })
    expect(container.textContent).toContain('3.30000000 LUX')
    expect(container.textContent).not.toContain('2.20000000 LUX')
  })

  it('stops at server expiry until the user explicitly refreshes', async () => {
    const expiresAt = new Date(Date.now() + 600).toISOString()
    previewResponse = () => ({
      type: 'promote-pricing-result',
      ok: true,
      quote: { ...quote, expiresAt },
    })
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() => expect(container.textContent).toContain(expiresAt))
    await vi.waitFor(
      () => {
        expect(container.textContent).toContain('报价已过期，请刷新后重新确认')
        expect(findButton('确认推广').disabled).toBe(true)
        expect(findButton('刷新报价')).toBeInstanceOf(HTMLButtonElement)
      },
      { timeout: 1_500 },
    )
    expect(
      requests.some(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toBe(false)
  })

  it('locks every request-changing control while a payment is pending', async () => {
    let resolvePromote: ((value: unknown) => void) | undefined
    promoteResponse = () =>
      new Promise((resolve) => {
        resolvePromote = resolve
      })
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() =>
      expect(container.textContent).toContain('2.20000000 LUX'),
    )
    await act(async () => {
      const confirm = findButton('确认推广')
      confirm.click()
      confirm.click()
    })

    expect(findButton('按上次配置').disabled).toBe(true)
    expect(findButton('赞').disabled).toBe(true)
    expect(findButton('提交中').disabled).toBe(true)
    for (const input of container.querySelectorAll('input')) {
      expect((input as HTMLInputElement).disabled).toBe(true)
    }
    await act(async () => findButton('赞').click())
    await act(async () => findButton('提交中').click())
    expect(
      requests.filter(
        (request) =>
          typeof request === 'object' &&
          request !== null &&
          'type' in request &&
          request.type === 'promote-tweet',
      ),
    ).toHaveLength(1)

    await act(async () => {
      resolvePromote?.({
        type: 'promote-result',
        ok: false,
        code: 'INTERNAL',
        message: 'Network response lost',
      })
      await Promise.resolve()
    })
    await vi.waitFor(() =>
      expect(findButton('重试同一请求')).toBeInstanceOf(HTMLButtonElement),
    )
    expect(findButton('赞').disabled).toBe(false)
  })

  it('retries an uncertain failure with the exact same quote and variables', async () => {
    let attempt = 0
    promoteResponse = () => {
      attempt += 1
      return attempt === 1
        ? {
            type: 'promote-result',
            ok: false,
            code: 'INTERNAL',
            message: 'Network response lost',
          }
        : {
            type: 'promote-result',
            ok: true,
            campaignIds: ['campaign-1'],
            reinvested: false,
          }
    }
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() =>
      expect(container.textContent).toContain('2.20000000 LUX'),
    )
    await act(async () => findButton('确认推广').click())
    await vi.waitFor(() =>
      expect(findButton('重试同一请求')).toBeInstanceOf(HTMLButtonElement),
    )
    await act(async () => findButton('重试同一请求').click())
    await vi.waitFor(() => expect(attempt).toBe(2))

    const promoteRequests = requests.filter(
      (request) =>
        typeof request === 'object' &&
        request !== null &&
        'type' in request &&
        request.type === 'promote-tweet',
    )
    expect(promoteRequests).toHaveLength(2)
    expect(promoteRequests[1]).toEqual(promoteRequests[0])
  })

  it('labels and renders every returned market schedule', async () => {
    previewResponse = () => ({
      type: 'promote-pricing-result',
      ok: true,
      quote: {
        ...quote,
        lines: [
          quote.lines[0],
          {
            ...quote.lines[0],
            campaignIndex: 1,
            actionType: 'RT',
            tier: 'B',
            todayPrice: '15.00000000',
            tomorrowExpectedPrice: '14.62500000',
            schedule: [
              { dayIndex: 0, unitPrice: '15.00000000' },
              { dayIndex: 1, unitPrice: '14.62500000' },
            ],
          },
        ],
      },
    })
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() => {
      expect(container.textContent).toContain('LIKE/A 价格日程')
      expect(container.textContent).toContain('第 1 日 0.39000000')
      expect(container.textContent).toContain('RT/B 价格日程')
      expect(container.textContent).toContain('第 1 日 14.62500000')
    })
  })

  it('recovers when preview messaging rejects instead of hanging', async () => {
    previewResponse = () => Promise.reject(new Error('port closed'))
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())

    await vi.waitFor(() => {
      expect(container.textContent).toContain('报价获取失败，请刷新后重试。')
      expect(findButton('刷新报价')).toBeInstanceOf(HTMLButtonElement)
    })
    expect(container.textContent).not.toContain('正在获取服务端报价')
  })

  it('offers the exact same retry when submit messaging rejects', async () => {
    let attempt = 0
    promoteResponse = () => {
      attempt += 1
      if (attempt === 1) return Promise.reject(new Error('port closed'))
      return {
        type: 'promote-result',
        ok: true,
        campaignIds: ['campaign-1'],
        reinvested: false,
      }
    }
    root = createRoot(container)
    await act(async () =>
      root?.render(
        <PromoteDialog
          tweetUrl="https://x.com/lighthouse/status/1"
          onClose={() => {}}
        />,
      ),
    )
    await act(async () => findButton('按上次配置').click())
    await vi.waitFor(() =>
      expect(container.textContent).toContain('2.20000000 LUX'),
    )
    await act(async () => findButton('确认推广').click())
    await vi.waitFor(() =>
      expect(findButton('重试同一请求')).toBeInstanceOf(HTMLButtonElement),
    )
    await act(async () => findButton('重试同一请求').click())
    await vi.waitFor(() => expect(attempt).toBe(2))

    const promoteRequests = requests.filter(
      (request) =>
        typeof request === 'object' &&
        request !== null &&
        'type' in request &&
        request.type === 'promote-tweet',
    )
    expect(promoteRequests).toHaveLength(2)
    expect(promoteRequests[1]).toEqual(promoteRequests[0])
  })
})
