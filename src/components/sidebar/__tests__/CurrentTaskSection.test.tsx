import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeBrowser } from 'wxt/testing'
import * as messaging from '@/lib/messaging'
import type { CampaignTaskCache } from '@/lib/storage'
import type { MsgResponse } from '@/types/messages'
import { MetadataBadge } from '../../chip/MetadataBadge'
import { CurrentTaskSection } from '../CurrentTaskSection'

let container: HTMLDivElement
let root: Root
let rows: CampaignTaskCache[]
let accountChanged: (
  changes: Record<string, chrome.storage.StorageChange>,
  area: 'local' | 'session' | 'sync' | 'managed',
) => void
let updated: (message: unknown) => void
beforeEach(() => {
  fakeBrowser.reset()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  window.history.replaceState({}, '', '/user/status/123456')
  rows = [
    {
      campaignId: 'a',
      tweetId: '123456',
      actionType: 'COMMENT',
      expectedReward: 1,
      authorName: '作者',
      reserved: true,
      commentGuide: `${'完整原文'.repeat(30)}\n第二行`,
      commentGuideStatus: 'ready',
      commentKeyword: '旧关键词',
    },
  ]
  vi.spyOn(chrome.storage.onChanged, 'addListener').mockImplementation(
    (listener) => {
      accountChanged = listener
    },
  )
  vi.spyOn(chrome.storage.onChanged, 'removeListener').mockImplementation(
    () => {},
  )
  vi.spyOn(chrome.runtime.onMessage, 'addListener').mockImplementation(
    (listener) => {
      updated = listener as typeof updated
    },
  )
  vi.spyOn(chrome.runtime.onMessage, 'removeListener').mockImplementation(
    () => {},
  )
  vi.spyOn(messaging, 'sendMessage').mockImplementation(async (req) => {
    if (req.type === 'get-tasks-snapshot')
      return {
        type: 'tasks-snapshot',
        byTweet: { '123456': rows },
        byAuthor: {},
        ready: true,
      }
    if (req.type === 'get-captured-actions')
      return { type: 'captured-actions', actions: [] }
    return { type: 'ack' }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})
const render = async () => act(async () => root.render(<CurrentTaskSection />))

describe('current-task comment guide', () => {
  it('shows claim-time identity only for an explicit true snapshot', async () => {
    rows[0].lighthouseSelectedAtClaim = true
    await render()
    expect(container.textContent).toContain('接单时严选')
    for (const snapshot of [false, null, undefined]) {
      rows[0].lighthouseSelectedAtClaim = snapshot
      await act(async () => updated({ type: 'tasks-updated' }))
      expect(container.textContent).not.toContain('接单时严选')
    }
  })
  it('shows the full original between the title and actions without keyword requirements', async () => {
    await render()
    const guide = container.querySelector('.lh-cur-guide-text')
    expect(guide?.textContent).toBe(rows[0].commentGuide)
    const text = container.textContent ?? ''
    expect(text.indexOf('作者')).toBeLessThan(text.indexOf('评论引导'))
    expect(text.indexOf('评论引导')).toBeLessThan(text.indexOf('要完成'))
    expect(text).not.toContain('旧关键词')
  })
  it('hides known null but distinguishes unknown and failed cached reads', async () => {
    rows[0].commentGuide = null
    await render()
    expect(container.textContent).not.toContain('评论引导')
    rows[0].commentGuide = undefined
    rows[0].commentGuideStatus = 'unavailable'
    await act(async () => updated({ type: 'tasks-updated' }))
    expect(container.textContent).toContain('评论引导暂时无法加载')
    rows[0].commentGuide = '缓存方向'
    rows[0].commentGuideStatus = 'stale'
    await act(async () => updated({ type: 'tasks-updated' }))
    expect(container.textContent).toContain('缓存方向')
    expect(container.textContent).toContain('更新失败')
  })
  it('shows unavailable instead of an endless skeleton when first synchronization fails', async () => {
    vi.mocked(messaging.sendMessage).mockImplementation(async (req) =>
      req.type === 'get-tasks-snapshot'
        ? {
            type: 'tasks-snapshot',
            byTweet: {},
            byAuthor: {},
            ready: false,
            syncFailed: true,
          }
        : { type: 'ack' },
    )
    await render()
    expect(container.textContent).toContain('评论引导暂时无法加载')
  })

  it('forces synchronization on opening an uncached task, reconnect and wake', async () => {
    rows = []
    await render()
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
    vi.mocked(messaging.sendMessage).mockClear()
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
    vi.mocked(messaging.sendMessage).mockClear()
    await act(async () => window.dispatchEvent(new Event('pageshow')))
    expect(messaging.sendMessage).toHaveBeenCalledWith({ type: 'force-sync' })
  })
  it('clears content on account change and rejects the previous snapshot response', async () => {
    await render()
    let resolveOld!: (response: MsgResponse) => void
    vi.mocked(messaging.sendMessage).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        }),
    )
    await act(async () => updated({ type: 'tasks-updated' }))
    const oldRows = rows
    rows = []
    expect(accountChanged).toBeTypeOf('function')
    await act(async () =>
      accountChanged({ apiToken: { oldValue: 'A', newValue: 'B' } }, 'local'),
    )
    expect(container.textContent).not.toContain('完整原文')
    await act(async () =>
      resolveOld({
        type: 'tasks-snapshot',
        byTweet: { '123456': oldRows },
        byAuthor: {},
        ready: true,
      }),
    )
    expect(container.textContent).not.toContain('完整原文')
  })
  for (const requestType of ['get-tasks-snapshot', 'force-sync'] as const) {
    it(`${requestType} failure without a cache shows unavailable`, async () => {
      const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
      rows = []
      vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
        if (req.type === requestType) throw new Error('RPC disconnected')
        return previous(req)
      })
      await render()
      expect(container.textContent).toContain('评论引导暂时无法加载')
    })

    it(`${requestType} failure retains a cached guide and marks update failure`, async () => {
      await render()
      const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
      vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
        if (req.type === requestType) throw new Error('RPC disconnected')
        return previous(req)
      })
      await act(async () => window.dispatchEvent(new Event('online')))
      expect(container.textContent).toContain('完整原文')
      expect(container.textContent).toContain('更新失败')
    })
  }

  for (const hasCache of [true, false]) {
    it(`clears an RPC failure after successful background sync (cache: ${hasCache})`, async () => {
      const recoveredRows = rows
      if (!hasCache) rows = []
      await render()
      const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
      let syncFailed = true
      vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
        if (req.type === 'force-sync') throw new Error('RPC disconnected')
        const response = await previous(req)
        return response.type === 'tasks-snapshot'
          ? { ...response, syncFailed }
          : response
      })
      await act(async () => window.dispatchEvent(new Event('online')))
      const failureText = hasCache ? '更新失败' : '评论引导暂时无法加载'
      expect(container.textContent).toContain(failureText)

      // A partial refresh must not treat a cached snapshot as recovery.
      await act(async () => updated({ type: 'tasks-updated' }))
      expect(container.textContent).toContain(failureText)

      syncFailed = false
      rows = recoveredRows
      rows[0].commentGuide = '后台成功刷新后的引导'
      await act(async () => updated({ type: 'tasks-updated' }))
      expect(container.textContent).toContain('后台成功刷新后的引导')
      expect(container.textContent).not.toContain('更新失败')
      expect(container.textContent).not.toContain('评论引导暂时无法加载')
    })
  }

  it('does not relabel old keywords as requirements in the tweet badge', async () => {
    await act(async () => root.render(<MetadataBadge tasks={rows} />))
    expect(container.querySelector('span')?.title).not.toContain('评论需含')
    expect(container.querySelector('span')?.title).not.toContain('完整原文')
  })
})
