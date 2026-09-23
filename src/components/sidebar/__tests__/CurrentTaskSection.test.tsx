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
  vi.useRealTimers()
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
    expect(text.indexOf('作者')).toBeLessThan(
      text.indexOf('买家希望的评论方向'),
    )
    expect(text.indexOf('买家希望的评论方向')).toBeLessThan(
      text.indexOf('要完成'),
    )
    expect(text).not.toContain('旧关键词')
  })
  it('hides known null but distinguishes unknown and failed cached reads', async () => {
    rows[0].commentGuide = null
    await render()
    expect(container.textContent).not.toContain('买家希望的评论方向')
    rows[0].commentGuide = undefined
    rows[0].commentGuideStatus = 'unavailable'
    await act(async () => updated({ type: 'tasks-updated' }))
    expect(container.textContent).toContain('评论方向暂时无法加载')
    rows[0].commentGuide = '缓存方向'
    rows[0].commentGuideStatus = 'stale'
    await act(async () => updated({ type: 'tasks-updated' }))
    expect(container.textContent).toContain('缓存方向')
    expect(container.textContent).toContain('更新失败')
  })
  it('stays closed after task updates until a different tweet is opened', async () => {
    await render()
    const close = container.querySelector<HTMLButtonElement>(
      '[aria-label="关闭任务面板"]',
    )
    expect(close).not.toBeNull()
    await act(async () => close!.click())
    expect(container.textContent).toBe('')
    await act(async () => updated({ type: 'tasks-updated' }))
    expect(container.textContent).toBe('')
  })
  it('stays hidden when first synchronization fails without a task', async () => {
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
    expect(container.textContent).toBe('')
  })

  it('recovers silently after force-sync fails without a task', async () => {
    const recovered = [{ ...rows[0], actionType: 'LIKE' as const }]
    rows = []
    const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
    let failed = true
    vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
      if (req.type === 'force-sync') {
        if (failed) return { type: 'sync-result', ok: false, error: 'offline' }
        rows = recovered
        return {
          type: 'sync-result',
          ok: true,
          lastSyncAt: Date.now(),
          taskCount: 1,
          tweetCount: 1,
        }
      }
      return previous(req)
    })
    await render()
    expect(container.textContent).toBe('')
    failed = false
    await act(async () => window.dispatchEvent(new Event('online')))
    expect(container.textContent).toContain('点赞')
    expect(container.textContent).not.toContain('任务暂时无法加载')
  })

  for (const change of ['account', 'route'] as const) {
    it(`ignores verification completion after ${change} changes`, async () => {
      vi.useFakeTimers()
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
      rows[0].actionType = 'LIKE'
      let complete!: (response: MsgResponse) => void
      const rewarded = vi.fn()
      const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
      vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
        if (req.type === 'get-captured-actions')
          return { type: 'captured-actions', actions: ['LIKE'] }
        if (req.type === 'verify-task')
          return new Promise((resolve) => {
            complete = resolve
          })
        return previous(req)
      })
      await act(async () =>
        root.render(<CurrentTaskSection onRewarded={rewarded} />),
      )
      await act(async () => vi.advanceTimersByTime(10_000))
      const verify = container.querySelector<HTMLButtonElement>('.lh-cur-btn')!
      expect(verify.disabled).toBe(false)
      await act(async () => verify.click())
      expect(complete).toBeTypeOf('function')
      if (change === 'account') {
        rows = [{ ...rows[0], campaignId: 'new-account-task' }]
        await act(async () =>
          accountChanged(
            { apiToken: { oldValue: 'A', newValue: 'B' } },
            'local',
          ),
        )
      } else {
        window.history.replaceState({}, '', '/user/status/654321')
        await act(async () => vi.advanceTimersByTime(500))
      }
      await act(async () =>
        complete({ type: 'verify-result', ok: true, reward: 0 }),
      )
      await act(async () => vi.advanceTimersByTime(3000))
      expect(rewarded).not.toHaveBeenCalled()
      expect(messaging.sendMessage).not.toHaveBeenCalledWith({
        type: 'open-task-hall',
      })
      expect(container.textContent).not.toContain('奖励发放中')
    })
  }

  it('stays hidden for an invalid snapshot without a known task', async () => {
    vi.mocked(messaging.sendMessage).mockResolvedValue({ type: 'ack' })
    await render()
    expect(container.textContent).toBe('')
    expect(container.textContent).not.toContain('重试加载')
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

  it('keeps syncing until a reserved task arrives after the old retry window', async () => {
    vi.useFakeTimers()
    const reservedTask = { ...rows[0], reserved: true }
    rows = []

    await render()
    await act(async () => vi.advanceTimersByTimeAsync(7_000))
    expect(container.textContent).toBe('')

    rows = [reservedTask]
    await act(async () => vi.advanceTimersByTimeAsync(8_000))

    expect(container.textContent).toContain('评论')
  })

  it('stays hidden after the task arrival window expires', async () => {
    vi.useFakeTimers()
    rows = []

    await render()
    await act(async () => vi.advanceTimersByTimeAsync(15_000))

    expect(container.textContent).toBe('')
    expect(container.textContent).not.toContain('重新同步')

    await act(async () => updated({ type: 'tasks-updated' }))
    expect(container.textContent).toBe('')
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
    it(`${requestType} failure without a cache stays hidden`, async () => {
      const previous = vi.mocked(messaging.sendMessage).getMockImplementation()!
      rows = []
      vi.mocked(messaging.sendMessage).mockImplementation(async (req) => {
        if (req.type === requestType) throw new Error('RPC disconnected')
        return previous(req)
      })
      await render()
      expect(container.textContent).toBe('')
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
      const failureText = hasCache ? '更新失败' : ''
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
      expect(container.textContent).not.toContain('评论方向暂时无法加载')
    })
  }

  it('does not relabel old keywords as requirements in the tweet badge', async () => {
    await act(async () => root.render(<MetadataBadge tasks={rows} />))
    expect(container.querySelector('span')?.title).not.toContain('评论需含')
    expect(container.querySelector('span')?.title).not.toContain('完整原文')
  })
})
