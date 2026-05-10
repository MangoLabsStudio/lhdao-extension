import { SYNC_INTERVAL_SECONDS, VERIFY_RETRY_DELAY_MS } from '@/lib/env'
import { GqlError, gql } from '@/lib/gql'
import { broadcastToContent, onMessage } from '@/lib/messaging'
import {
  AVAILABLE_ENGAGEMENTS_QUERY,
  type AvailableEngagementsResult,
  type EngagementActionType,
  RESERVE_SLOT_MUTATION,
  type ReserveSlotResult,
  VERIFY_ENGAGEMENT_MUTATION,
  type VerifyEngagementResult,
} from '@/lib/queries'
import { type CampaignTaskCache, localStore, sessionStore } from '@/lib/storage'
import { extractTweetIdFromUrl } from '@/lib/twitter-dom'
import type { MsgResponse, SubmitErrorCode } from '@/types/messages'

const ALARM_NAME = 'lhdao-sync'
const SUPPORTED_ACTIONS = new Set<EngagementActionType>([
  'LIKE',
  'RT',
  'COMMENT',
  'COMMENT_LIKE',
])

/**
 * Background service worker.
 *
 *   - 启动 / 60s alarm 触发 → syncTasks() 拉取可参与任务,扁平化进 sessionStore
 *   - content script 来 RPC → 响应任务查询 / 处理 chip 点击 reserve+verify
 *   - 任务列表更新后广播 'tasks-updated',content script 收到立刻 rescan
 */
export default defineBackground(() => {
  console.log('[lhdao] background worker booted')

  // 启动立刻 sync 一次,然后每 60s
  void syncTasks()
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: SYNC_INTERVAL_SECONDS / 60,
  })
  chrome.alarms.onAlarm.addListener((a) => {
    if (a.name === ALARM_NAME) void syncTasks()
  })

  onMessage(async (req): Promise<MsgResponse> => {
    if (req.type === 'get-tasks-for-tweet') {
      const map = (await sessionStore.get('tasksByTweetId')) ?? {}
      return { type: 'tasks', tasks: map[req.tweetId] ?? [] }
    }
    if (req.type === 'submit-task') {
      return submitTask(req.campaignId)
    }
    if (req.type === 'has-token') {
      const token = await localStore.get('apiToken')
      return { type: 'token-status', configured: !!token }
    }
    if (req.type === 'force-sync') {
      // popup "刷新" 按钮的入口 — 等 sync 跑完再 return,UI 可以即时
      // 看到错误或最新计数,不用等下一个 60s alarm。
      await syncTasks()
      const err = await sessionStore.get('lastSyncError')
      const httpStatus = await sessionStore.get('lastSyncHttpStatus')
      if (err) {
        return {
          type: 'sync-result',
          ok: false,
          error: err,
          httpStatus: httpStatus ?? undefined,
        }
      }
      const map = (await sessionStore.get('tasksByTweetId')) ?? {}
      let taskCount = 0
      let tweetCount = 0
      for (const arr of Object.values(map)) {
        if (arr.length > 0) {
          tweetCount += 1
          taskCount += arr.length
        }
      }
      return {
        type: 'sync-result',
        ok: true,
        lastSyncAt: (await sessionStore.get('lastSyncAt')) ?? Date.now(),
        taskCount,
        tweetCount,
      }
    }
    return { type: 'ack' }
  })

  // token 写入 / 删除 → 立即重新 sync(用户在 options 页粘贴 token 后,
  // 不必等下一个 60s alarm 才看到任务)
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'apiToken' in changes) {
      void syncTasks()
    }
  })
})

// ── sync ─────────────────────────────────────────────────────────────

async function syncTasks(): Promise<void> {
  const token = await localStore.get('apiToken')
  if (!token) {
    // 没 token 就清空缓存,避免遗留旧任务被点击
    await sessionStore.set('tasksByTweetId', {})
    await sessionStore.set('lastSyncError', 'No API token configured')
    await sessionStore.set('lastSyncHttpStatus', null)
    return
  }

  try {
    const data = await gql<AvailableEngagementsResult>(
      AVAILABLE_ENGAGEMENTS_QUERY,
    )
    const map = flattenTasks(data.availableEngagements)
    await sessionStore.set('tasksByTweetId', map)
    await sessionStore.set('lastSyncAt', Date.now())
    await sessionStore.set('lastSyncError', null)
    await sessionStore.set('lastSyncHttpStatus', null)
    broadcastToContent({ type: 'tasks-updated' })
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    const httpStatus = e instanceof GqlError ? (e.httpStatus ?? null) : null
    await sessionStore.set('lastSyncError', msg)
    await sessionStore.set('lastSyncHttpStatus', httpStatus)
    console.warn('[lhdao] sync failed', e)
    // 不清空缓存 — 网络抖动时旧数据比空数据更可用
  }
}

/**
 * 把后端返的 engagement 列表扁平化成 {tweetId → CampaignTaskCache[]} 索引,
 * content script 拿到 tweet id 时 O(1) 查询。
 */
function flattenTasks(
  engagements: AvailableEngagementsResult['availableEngagements'],
): Record<string, CampaignTaskCache[]> {
  const map: Record<string, CampaignTaskCache[]> = {}
  for (const c of engagements) {
    if (c.type !== 'ENGAGEMENT') continue
    const tweetId = c.targetUrl ? extractTweetIdFromUrl(c.targetUrl) : null
    if (!tweetId) continue

    for (const a of c.actions) {
      if (!SUPPORTED_ACTIONS.has(a.actionType)) continue
      const bucket = map[tweetId] ?? []
      bucket.push({
        campaignId: c.id,
        tweetId,
        actionType: a.actionType,
        expectedReward: a.baseReward,
        commentKeyword: a.commentGuide,
      })
      map[tweetId] = bucket
    }
  }
  return map
}

// ── submit (reserve + verify) ────────────────────────────────────────

/**
 * Chip 点击的完整流程:
 *   1. reserveEngagementSlot — 占席位
 *      - "Already participated" 视为成功,跳到 verify
 *      - SLOT_FULL / BOT_BLOCKED 直接返回失败,UI 给特定文案
 *   2. verifyEngagement — 系统去 Twitter API 校验是否真做了
 *      - 失败一次,等 5s 重试一次(Twitter API 缓存延迟兜底)
 *      - 第二次还失败就返回错误 code
 *   3. 成功后 syncTasks() 刷新缓存,chip 自动消失
 */
async function submitTask(campaignId: string): Promise<MsgResponse> {
  // —— Reserve ——
  try {
    await gql<ReserveSlotResult>(RESERVE_SLOT_MUTATION, { campaignId })
  } catch (e) {
    if (e instanceof GqlError) {
      const msg = e.message
      // 已经 reserve 过 → 跳过,直接 verify(幂等)
      if (!/Already participated/i.test(msg)) {
        return reserveError(msg, e.httpStatus)
      }
    } else {
      return {
        type: 'submit-result',
        ok: false,
        code: 'INTERNAL',
        message: String(e),
      }
    }
  }

  // —— Verify (1 retry) ——
  for (let i = 0; i < 2; i++) {
    try {
      const data = await gql<VerifyEngagementResult>(
        VERIFY_ENGAGEMENT_MUTATION,
        {
          campaignId,
        },
      )
      const reward = Number(data.verifyEngagement?.actualReward ?? 0)
      void syncTasks() // 刷新缓存,完成的任务消失
      return { type: 'submit-result', ok: true, reward }
    } catch (e) {
      const isLast = i === 1
      if (isLast) {
        const msg = e instanceof Error ? e.message : String(e)
        const httpStatus = e instanceof GqlError ? e.httpStatus : undefined
        return verifyError(msg, httpStatus)
      }
      await sleep(VERIFY_RETRY_DELAY_MS)
    }
  }

  return {
    type: 'submit-result',
    ok: false,
    code: 'INTERNAL',
    message: 'unreachable',
  }
}

function reserveError(msg: string, httpStatus?: number): MsgResponse {
  let code: SubmitErrorCode = 'RESERVE_FAILED'
  if (httpStatus === 401) code = 'TOKEN_INVALID'
  else if (/Slot full/i.test(msg)) code = 'SLOT_FULL'
  else if (/BotUserBlocked/i.test(msg)) code = 'BOT_BLOCKED'
  return { type: 'submit-result', ok: false, code, message: msg }
}

function verifyError(msg: string, httpStatus?: number): MsgResponse {
  let code: SubmitErrorCode = 'VERIFY_FAILED'
  if (httpStatus === 401) code = 'TOKEN_INVALID'
  else if (/CommentMissingKeyword/i.test(msg)) code = 'COMMENT_MISSING'
  else if (/WrongTwitterAccount/i.test(msg)) code = 'WRONG_X_ACCOUNT'
  else if (/TwitterApiNotReady/i.test(msg)) code = 'API_NOT_READY'
  else if (/ActionNotDetected|NotDetected/i.test(msg))
    code = 'ACTION_NOT_DETECTED'
  return { type: 'submit-result', ok: false, code, message: msg }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
