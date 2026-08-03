import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import type { BinanceProbeObservation } from '@/lib/binance-square-probe'

const capture = vi.hoisted(() => ({ enabled: true }))

vi.mock('@/lib/capture-debug', () => ({
  get CAPTURE_DEBUG() {
    return capture.enabled
  },
}))

import { BinanceProbePanel } from './App'

;(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const observations: BinanceProbeObservation[] = [
  {
    id: '3d594650-3436-4c3b-8fd1-10f696459434',
    method: 'POST',
    path: '/bapi/v1/square/post/:id/like',
    status: 200,
    target: { kind: 'CONTENT', id: '123456789012' },
    requestShape: { postId: '<target:CONTENT>' },
    responseShape: { code: '<number>' },
    capturedAt: '2026-08-04T01:02:03.000Z',
  },
]

let root: Root | null = null
let container: HTMLElement
let requests: unknown[]
const writeText = vi.fn(async () => undefined)

function findButton(label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.textContent?.includes(label),
  )
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

async function renderPanel() {
  root = createRoot(container)
  await act(async () => root?.render(<BinanceProbePanel />))
}

describe('BinanceProbePanel', () => {
  beforeEach(() => {
    capture.enabled = true
    fakeBrowser.reset()
    requests = []
    document.body.replaceChildren()
    container = document.createElement('div')
    document.body.append(container)
    writeText.mockClear()
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    fakeBrowser.runtime.onMessage.addListener(async (message: unknown) => {
      requests.push(structuredClone(message))
      return message &&
        typeof message === 'object' &&
        'type' in message &&
        message.type === 'export-binance-probe-observations'
        ? { type: 'binance-probe-observations', observations }
        : { type: 'ack' }
    })
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it('copies only the exported sanitized fixtures', async () => {
    await renderPanel()
    await vi.waitFor(() => expect(container.textContent).toContain('1 条'))

    await act(async () => findButton('复制脱敏 fixtures').click())

    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        JSON.stringify(observations, null, 2),
      )
    })
    expect(requests).toContainEqual({
      type: 'export-binance-probe-observations',
    })
  })

  it('clears the session fixtures and resets the copied state', async () => {
    await renderPanel()
    await vi.waitFor(() => expect(container.textContent).toContain('1 条'))
    await act(async () => findButton('复制脱敏 fixtures').click())
    await vi.waitFor(() => expect(container.textContent).toContain('已复制'))

    await act(async () => findButton('清空').click())

    await vi.waitFor(() => expect(container.textContent).toContain('0 条'))
    expect(container.textContent).not.toContain('已复制')
    expect(requests).toContainEqual({
      type: 'clear-binance-probe-observations',
    })
  })

  it('renders nothing when capture debug is disabled', async () => {
    capture.enabled = false

    await renderPanel()

    expect(container.innerHTML).toBe('')
    expect(requests).toEqual([])
  })
})
