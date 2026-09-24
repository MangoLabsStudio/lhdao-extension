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
let exportObservations: () => Promise<BinanceProbeObservation[]>
let clearResponse: () => Promise<unknown>

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
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
    exportObservations = async () => observations
    clearResponse = async () => ({ type: 'ack' })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    fakeBrowser.runtime.onMessage.addListener(async (message: unknown) => {
      requests.push(structuredClone(message))
      if (!message || typeof message !== 'object' || !('type' in message)) {
        return { type: 'ack' }
      }
      if (message.type === 'export-binance-probe-observations') {
        return {
          type: 'binance-probe-observations',
          observations: await exportObservations(),
        }
      }
      if (message.type === 'clear-binance-probe-observations') {
        return clearResponse()
      }
      return { type: 'ack' }
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

  it('lets clear win over an older pending copy', async () => {
    await renderPanel()
    await vi.waitFor(() => expect(container.textContent).toContain('1 条'))
    const pending = deferred<BinanceProbeObservation[]>()
    exportObservations = () => pending.promise

    await act(async () => {
      findButton('复制脱敏 fixtures').click()
      findButton('清空').click()
    })
    pending.resolve(observations)
    await act(async () => pending.promise)

    expect(container.textContent).toContain('0 条')
    expect(container.textContent).not.toContain('已复制')
    expect(writeText).not.toHaveBeenCalled()
  })

  it('keeps the fixtures and reports an unsuccessful clear response', async () => {
    await renderPanel()
    await vi.waitFor(() => expect(container.textContent).toContain('1 条'))
    await act(async () => findButton('复制脱敏 fixtures').click())
    await vi.waitFor(() => expect(container.textContent).toContain('已复制'))
    clearResponse = async () => ({
      type: 'submit-result',
      ok: false,
      code: 'INTERNAL',
      message: 'background failed',
    })

    await act(async () => findButton('清空').click())

    await vi.waitFor(() => expect(container.textContent).toContain('清空失败'))
    expect(container.textContent).toContain('1 条')
    expect(container.textContent).toContain('已复制')
  })

  it('renders nothing when capture debug is disabled', async () => {
    capture.enabled = false

    await renderPanel()

    expect(container.innerHTML).toBe('')
    expect(requests).toEqual([])
  })
})
