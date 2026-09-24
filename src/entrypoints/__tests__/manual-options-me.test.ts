import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import { gql } from '@/lib/gql'

vi.mock('@/lib/env', () => ({ WEB_ENDPOINT: 'https://example.test' }))
vi.mock('@/lib/gql', () => ({
  gql: vi.fn(async () => ({
    me: { id: 'user', username: 'alice', tier: 'A' },
  })),
}))
vi.mock('@/lib/messaging', () => ({
  sendMessage: vi.fn(async () => ({
    type: 'pairing-status-result',
    state: { kind: 'idle' },
  })),
}))

let root: Root
let container: HTMLDivElement

beforeEach(async () => {
  fakeBrowser.reset()
  vi.mocked(gql).mockClear()
  Object.assign(globalThis, {
    chrome: fakeBrowser,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  await fakeBrowser.storage.local.set({ apiToken: 'lhdao_pk_test_token' })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('shows an existing token without automatically querying me', async () => {
  const { App } = await import('../options/App')
  await act(async () => root.render(createElement(App)))

  expect(gql).not.toHaveBeenCalled()
  expect(container.textContent).toContain('token 已保存')
})
