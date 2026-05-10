/**
 * Content script ↔ Background service worker RPC 协议。
 *
 * 设计:
 *   - 强类型 union,新加 message 必须同时改这里 + handler
 *   - 错误结果走显式分支(`ok: false` + 错误 code),不抛异常给 content
 *   - 单向广播(BG → CS)用 `tasks-updated`,响应永远是 `ack`
 */

import type { CampaignTaskCache } from '@/lib/storage'

// ── Requests (CS → BG, 偶尔反向) ─────────────────────────────────────

export type MsgRequest =
  /** content script 询问某条推文上挂着哪些任务 */
  | { type: 'get-tasks-for-tweet'; tweetId: string }
  /** content script 提交 chip 点击 — BG 走 reserve + verify 流程 */
  | { type: 'submit-task'; campaignId: string }
  /** content script 询问当前是否已配置 token (popup 也用) */
  | { type: 'has-token' }
  /** BG → CS 广播:任务列表已更新,请重新查询 */
  | { type: 'tasks-updated' }

// ── Responses ────────────────────────────────────────────────────────

export type MsgResponse =
  | { type: 'tasks'; tasks: CampaignTaskCache[] }
  | { type: 'submit-result'; ok: true; reward: number }
  | { type: 'submit-result'; ok: false; code: SubmitErrorCode; message: string }
  | { type: 'token-status'; configured: boolean }
  | { type: 'ack' }

/**
 * submit-task 失败的标准 code。让 content script 决定 toast 文案,
 * 后端透传的 GraphQL extensions.code 也优先 map 到这里。
 */
export type SubmitErrorCode =
  | 'NO_TOKEN'
  | 'TOKEN_INVALID'
  | 'SLOT_FULL'
  | 'ALREADY_DONE'
  | 'ACTION_NOT_DETECTED'
  | 'NETWORK'
  | 'INTERNAL'
