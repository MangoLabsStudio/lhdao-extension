import { describe, expect, it } from 'vitest'
import { buildProofCanonical, hmacSignProof, randomProofNonce } from '../proof'

// sha256('') 的 hex —— 与后端 proof-canonical.ts 的 commentHash 口径对齐(空评论)。
const SHA256_EMPTY =
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

describe('randomProofNonce', () => {
  it('32 位 hex、每次不同', () => {
    const a = randomProofNonce()
    const b = randomProofNonce()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toBe(b)
  })
})

describe('buildProofCanonical', () => {
  it('格式与后端一致(campaignId|ts|nonce|sortedActions|sha256(comment)|dwell)', async () => {
    const c = await buildProofCanonical({
      campaignId: 'c1',
      ts: 100,
      nonce: 'n',
      actions: [
        { actionType: 'RT', tweetId: 't1' },
        { actionType: 'LIKE', tweetId: 't1' },
      ],
    })
    // 动作按字典序:LIKE:t1 在 RT:t1 前;空评论走 SHA256_EMPTY;dwell 缺省 0
    expect(c).toBe(`c1|100|n|LIKE:t1,RT:t1|${SHA256_EMPTY}|0`)
  })

  it('动作顺序无关', async () => {
    const a = await buildProofCanonical({
      campaignId: 'c1',
      ts: 1,
      nonce: 'n',
      actions: [
        { actionType: 'COMMENT', tweetId: 't1' },
        { actionType: 'LIKE', tweetId: 't1' },
      ],
    })
    const b = await buildProofCanonical({
      campaignId: 'c1',
      ts: 1,
      nonce: 'n',
      actions: [
        { actionType: 'LIKE', tweetId: 't1' },
        { actionType: 'COMMENT', tweetId: 't1' },
      ],
    })
    expect(a).toBe(b)
  })

  it('FOLLOW 无 tweetId + 无 handle → 空段;commentText 变则串变', async () => {
    const noComment = await buildProofCanonical({
      campaignId: 'c1',
      ts: 1,
      nonce: 'n',
      actions: [{ actionType: 'FOLLOW' }],
    })
    expect(noComment).toContain('|FOLLOW:|')
    const withComment = await buildProofCanonical({
      campaignId: 'c1',
      ts: 1,
      nonce: 'n',
      actions: [{ actionType: 'FOLLOW' }],
      commentText: 'gm',
    })
    expect(withComment).not.toBe(noComment)
  })

  it('FOLLOW 带 handle → handle 进动作段(必须与后端字节一致)', async () => {
    // FOLLOW 无 tweetId,handle 落到 tweetId 槽:`FOLLOW:<handle>`。这是插件权威
    // 验关注的前提;后端 proof-canonical.spec.ts 有等价断言,两处必须一致。
    const s = await buildProofCanonical({
      campaignId: 'c1',
      ts: 100,
      nonce: 'n',
      actions: [{ actionType: 'FOLLOW', handle: 'alice' }],
    })
    expect(s).toBe(`c1|100|n|FOLLOW:alice|${SHA256_EMPTY}|0`)
    // handle 变 → 串变(签名保护「关注了谁」)
    const s2 = await buildProofCanonical({
      campaignId: 'c1',
      ts: 100,
      nonce: 'n',
      actions: [{ actionType: 'FOLLOW', handle: 'bob' }],
    })
    expect(s2).not.toBe(s)
  })
})

describe('hmacSignProof', () => {
  it('同 key+canonical 稳定,不同 canonical 不同', async () => {
    // macKey 是 base64url 的原始字节(43 字符 = 32 字节,合法 base64url)
    const macKey = 'a'.repeat(43)
    const s1 = await hmacSignProof(macKey, 'a|b|c')
    const s2 = await hmacSignProof(macKey, 'a|b|c')
    const s3 = await hmacSignProof(macKey, 'a|b|d')
    expect(s1).toBe(s2)
    expect(s1).not.toBe(s3)
    expect(s1).toMatch(/^[A-Za-z0-9_-]+$/) // base64url,无 +/=
  })
})
