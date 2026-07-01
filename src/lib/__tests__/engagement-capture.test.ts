import { describe, expect, it } from 'vitest'
import {
  actionMatchesTask,
  extractCapturedAction,
  mapCaptureToCampaigns,
  mergeAction,
} from '../engagement-capture'

const body = (variables: unknown) => JSON.stringify({ variables })

describe('extractCapturedAction', () => {
  it('FavoriteTweet + tweet_id → LIKE', () => {
    expect(
      extractCapturedAction('FavoriteTweet', body({ tweet_id: '123' })),
    ).toEqual({
      actionType: 'LIKE',
      tweetId: '123',
    })
  })
  it('CreateRetweet + tweet_id → RT', () => {
    expect(
      extractCapturedAction('CreateRetweet', body({ tweet_id: 456 })),
    ).toEqual({
      actionType: 'RT',
      tweetId: '456',
    })
  })
  it('CreateTweet 带 in_reply_to → COMMENT + 正文', () => {
    expect(
      extractCapturedAction(
        'CreateTweet',
        body({ reply: { in_reply_to_tweet_id: '789' }, tweet_text: 'gm' }),
      ),
    ).toEqual({ actionType: 'COMMENT', tweetId: '789', commentText: 'gm' })
  })
  it('CreateTweet 原创(无 in_reply_to)→ null', () => {
    expect(
      extractCapturedAction('CreateTweet', body({ tweet_text: 'hello' })),
    ).toBeNull()
  })
  it('FavoriteTweet 缺 tweet_id → null', () => {
    expect(extractCapturedAction('FavoriteTweet', body({}))).toBeNull()
  })
  it('未知 op / 无 body / 坏 JSON → null', () => {
    expect(
      extractCapturedAction('UnfavoriteTweet', body({ tweet_id: '1' })),
    ).toBeNull()
    expect(extractCapturedAction('FavoriteTweet', undefined)).toBeNull()
    expect(extractCapturedAction(null, body({ tweet_id: '1' }))).toBeNull()
    expect(extractCapturedAction('FavoriteTweet', 'not-json')).toBeNull()
  })
})

describe('actionMatchesTask', () => {
  it('精确匹配', () => {
    expect(actionMatchesTask('LIKE', 'LIKE')).toBe(true)
    expect(actionMatchesTask('RT', 'RT')).toBe(true)
    expect(actionMatchesTask('COMMENT', 'COMMENT')).toBe(true)
  })
  it('COMMENT_LIKE 组合:COMMENT/LIKE 命中,RT 不命中', () => {
    expect(actionMatchesTask('COMMENT', 'COMMENT_LIKE')).toBe(true)
    expect(actionMatchesTask('LIKE', 'COMMENT_LIKE')).toBe(true)
    expect(actionMatchesTask('RT', 'COMMENT_LIKE')).toBe(false)
  })
  it('不匹配', () => {
    expect(actionMatchesTask('LIKE', 'RT')).toBe(false)
    expect(actionMatchesTask('RT', 'FOLLOW')).toBe(false)
  })
})

describe('mapCaptureToCampaigns', () => {
  const snapshot = {
    t1: [
      { campaignId: 'cA', actionType: 'LIKE' },
      { campaignId: 'cB', actionType: 'RT' },
    ],
    t2: [{ campaignId: 'cC', actionType: 'COMMENT_LIKE' }],
  }
  it('单命中', () => {
    expect(
      mapCaptureToCampaigns({ actionType: 'LIKE', tweetId: 't1' }, snapshot),
    ).toEqual([{ campaignId: 'cA', actionType: 'LIKE', tweetId: 't1' }])
  })
  it('COMMENT 命中 COMMENT_LIKE 任务 + 带 commentText', () => {
    expect(
      mapCaptureToCampaigns(
        { actionType: 'COMMENT', tweetId: 't2', commentText: 'gm' },
        snapshot,
      ),
    ).toEqual([
      {
        campaignId: 'cC',
        actionType: 'COMMENT',
        tweetId: 't2',
        commentText: 'gm',
      },
    ])
  })
  it('该 tweet 无匹配任务 → 空', () => {
    expect(
      mapCaptureToCampaigns({ actionType: 'RT', tweetId: 't2' }, snapshot),
    ).toEqual([])
    expect(
      mapCaptureToCampaigns({ actionType: 'LIKE', tweetId: 'tX' }, snapshot),
    ).toEqual([])
  })
})

describe('mergeAction', () => {
  it('从空累积', () => {
    expect(
      mergeAction(undefined, {
        actionType: 'LIKE',
        tweetId: 't1',
        capturedAt: 'a',
      }),
    ).toEqual([{ actionType: 'LIKE', tweetId: 't1', capturedAt: 'a' }])
  })
  it('不同动作累加(多动作任务不互相覆盖)', () => {
    const r = mergeAction(
      [{ actionType: 'LIKE', tweetId: 't1', capturedAt: 'a' }],
      { actionType: 'RT', tweetId: 't1', capturedAt: 'b' },
    )
    expect(r).toHaveLength(2)
    expect(r.map((x) => x.actionType).sort()).toEqual(['LIKE', 'RT'])
  })
  it('同动作去重、后到覆盖', () => {
    const r = mergeAction(
      [{ actionType: 'LIKE', tweetId: 't1', capturedAt: 'a' }],
      { actionType: 'LIKE', tweetId: 't1', capturedAt: 'b' },
    )
    expect(r).toEqual([{ actionType: 'LIKE', tweetId: 't1', capturedAt: 'b' }])
  })
})
