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
      if (message.type === 'promote-tweet') {
        return {
          type: 'promote-result',
          ok: false,
          code: 'PLUGIN_DEVICE_DENIED',
          message: 'PLUGIN_DEVICE_DENIED: 你没有权限执行此操作。',
        }
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
    await act(async () => findButton('确认推广').click())

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
})
