import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import type { MsgResponse } from '@/types/messages'
import { App } from './App'

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

interface PopupHarness {
  container: HTMLElement
  requests: unknown[]
}

let root: Root | null = null

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
  fakeBrowser.reset()
})

async function renderPopup(
  popupData: Extract<MsgResponse, { type: 'popup-data' }> = POPUP_DATA,
): Promise<PopupHarness> {
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
      default:
        return { type: 'ack' }
    }
  })

  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root?.render(<App />))
  await vi.waitFor(() => {
    expect(requests).toContainEqual({ type: 'get-popup-data' })
  })

  return {
    container,
    requests,
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

describe('popup connection', () => {
  it('reconnects a token that is not bound to the current browser', async () => {
    const { container, requests } = await renderPopup({
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
