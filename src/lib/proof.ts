// [B3 插件专用验证] 捕获结果证明的规范化串 + HMAC 签名。
//
// buildProofCanonical 必须与后端 src/modules/plugin-verify/proof-canonical.ts
// **逐字节一致**,否则签名对不上:
//   campaignId | ts | nonce | sortedActions | sha256hex(commentText||'') | dwellMs
// sortedActions = 每动作 `actionType:tweetId`(缺省空)按字典序排序 `,` 连接。
//
// macKey 是后端 mintEngagementTicket 随票下发的一次性密钥(base64url)。SW 里用
// WebCrypto 做 HMAC-SHA256,结果 base64url。

import {
  randomProofNonce as createRandomProofNonce,
  hmacSha256Base64Url,
  sha256Hex,
} from './proof-crypto'

export interface ProofAction {
  actionType: string
  tweetId?: string | null
  /** FOLLOW 的被关注 handle(无 @,小写)。绑进 canonical 让后端权威验「关注了谁」。 */
  handle?: string | null
  /** COMMENT 成功响应里的新回复 tweet ID。存在时一并绑入 HMAC。 */
  resultTweetId?: string | null
}

/** 32-hex 随机 nonce(单次防重放)。 */
export function randomProofNonce(): string {
  return createRandomProofNonce()
}

export async function buildProofCanonical(args: {
  campaignId: string
  ts: number
  nonce: string
  actions: ProofAction[]
  commentText?: string | null
  dwellMs?: number | null
}): Promise<string> {
  // 动作段:非 FOLLOW 用 tweetId;FOLLOW 无 tweetId,用被关注 handle —— 把
  // 「关注了谁」也绑进签名。必须与后端 proof-canonical.ts 逐字节一致。
  const actionsPart = (args.actions ?? [])
    .map((a) => {
      const base = `${a.actionType}:${a.tweetId ?? a.handle ?? ''}`
      return a.resultTweetId ? `${base}>${a.resultTweetId}` : base
    })
    .sort()
    .join(',')
  const commentHash = await sha256Hex(args.commentText ?? '')
  const dwell =
    typeof args.dwellMs === 'number' && Number.isFinite(args.dwellMs)
      ? Math.floor(args.dwellMs)
      : 0
  return [
    args.campaignId,
    args.ts,
    args.nonce,
    actionsPart,
    commentHash,
    dwell,
  ].join('|')
}

/** sig = base64url(HMAC-SHA256(macKey, canonical))。 */
export async function hmacSignProof(
  macKeyB64url: string,
  canonical: string,
): Promise<string> {
  return hmacSha256Base64Url(macKeyB64url, canonical)
}
