import { describe, expect, it } from 'vitest'
import {
  actionMatchesTask,
  type CapturedAction,
  extractCapturedAction,
  extractCreatedCommentTweetId,
  extractFollowFromResponse,
  extractSuccessfulCapturedAction,
  mapCaptureToCampaigns,
  mergeAction,
  type ReportedAction,
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
  it('CreateNoteTweet(长评论/Premium)带 in_reply_to → COMMENT + 正文', () => {
    expect(
      extractCapturedAction(
        'CreateNoteTweet',
        body({
          reply: { in_reply_to_tweet_id: '789' },
          tweet_text: '长评论...',
        }),
      ),
    ).toEqual({
      actionType: 'COMMENT',
      tweetId: '789',
      commentText: '长评论...',
    })
  })
  it('CreateNoteTweet 结构变体:reply/正文嵌在 note_tweet 下 → 仍能抽出', () => {
    expect(
      extractCapturedAction(
        'CreateNoteTweet',
        body({
          note_tweet: {
            reply: { in_reply_to_tweet_id: '999' },
            text: 'gm long',
          },
        }),
      ),
    ).toEqual({ actionType: 'COMMENT', tweetId: '999', commentText: 'gm long' })
  })
  it('CreateNoteTweet 原创(无 in_reply_to)→ null', () => {
    expect(
      extractCapturedAction('CreateNoteTweet', body({ tweet_text: 'hi' })),
    ).toBeNull()
  })
  it('FavoriteTweet 缺 tweet_id → null', () => {
    expect(extractCapturedAction('FavoriteTweet', body({}))).toBeNull()
  })
  it('CreateTweet:in_reply_to 深埋在别的路径 → 深查兜底仍判 COMMENT', () => {
    expect(
      extractCapturedAction(
        'CreateTweet',
        body({ tweet: { reply: { in_reply_to_tweet_id: '555' } }, text: 'hi' }),
      ),
    ).toEqual({ actionType: 'COMMENT', tweetId: '555', commentText: 'hi' })
  })
  it('CreateTweet:顶层扁平 in_reply_to_tweet_id → COMMENT', () => {
    expect(
      extractCapturedAction(
        'CreateTweet',
        body({ in_reply_to_tweet_id: 777, tweet_text: 'gm' }),
      ),
    ).toEqual({ actionType: 'COMMENT', tweetId: '777', commentText: 'gm' })
  })
  it('CreateTweet:老键名 in_reply_to_status_id → COMMENT', () => {
    expect(
      extractCapturedAction(
        'CreateTweet',
        body({ reply: { in_reply_to_status_id: '888' }, tweet_text: 'ok' }),
      ),
    ).toEqual({ actionType: 'COMMENT', tweetId: '888', commentText: 'ok' })
  })
  it('CreateTweet:任何层级都没 reply id(真原创)→ 仍 null,不误判', () => {
    expect(
      extractCapturedAction(
        'CreateTweet',
        body({ tweet: { text: 'brand new', extra: { a: 1 } } }),
      ),
    ).toBeNull()
  })
  it('FavoriteTweet:tweet_id 嵌在深层 → 深查兜底仍判 LIKE', () => {
    expect(
      extractCapturedAction(
        'FavoriteTweet',
        body({ input: { tweet_id: '42' } }),
      ),
    ).toEqual({ actionType: 'LIKE', tweetId: '42' })
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

describe('extractCreatedCommentTweetId', () => {
  it('extracts CreateTweet response rest_id', () => {
    expect(
      extractCreatedCommentTweetId('CreateTweet', {
        data: {
          create_tweet: { tweet_results: { result: { rest_id: '19001' } } },
        },
      }),
    ).toBe('19001')
  })

  it('extracts CreateNoteTweet response variants', () => {
    expect(
      extractCreatedCommentTweetId('CreateNoteTweet', {
        data: {
          notetweet_create: {
            tweet_results: { result: { tweet: { rest_id: '19002' } } },
          },
        },
      }),
    ).toBe('19002')
  })

  it('does not infer a result ID from unrelated response fields', () => {
    expect(
      extractCreatedCommentTweetId('CreateTweet', {
        data: { target_tweet: { rest_id: 'parent-id' } },
      }),
    ).toBeNull()
  })
})

describe('extractFollowFromResponse', () => {
  it('friendships/create 响应带 screen_name → FOLLOW(handle 小写)', () => {
    expect(
      extractFollowFromResponse(
        'https://x.com/i/api/1.1/friendships/create.json',
        { id: 1, screen_name: 'AliceKOL', name: 'Alice' },
      ),
    ).toEqual({ actionType: 'FOLLOW', handle: 'alicekol' })
  })
  it('非 friendships/create URL → null', () => {
    expect(
      extractFollowFromResponse(
        'https://x.com/i/api/1.1/friendships/destroy.json',
        {
          screen_name: 'bob',
        },
      ),
    ).toBeNull()
    expect(
      extractFollowFromResponse(undefined, { screen_name: 'bob' }),
    ).toBeNull()
  })
  it('响应无 screen_name → null', () => {
    expect(
      extractFollowFromResponse('/i/api/1.1/friendships/create.json', {
        id: 1,
      }),
    ).toBeNull()
    expect(
      extractFollowFromResponse('/i/api/1.1/friendships/create.json', null),
    ).toBeNull()
  })
})

describe('actionMatchesTask', () => {
  it('精确匹配', () => {
    expect(actionMatchesTask('LIKE', 'LIKE')).toBe(true)
    expect(actionMatchesTask('RT', 'RT')).toBe(true)
    expect(actionMatchesTask('COMMENT', 'COMMENT')).toBe(true)
    expect(actionMatchesTask('FOLLOW', 'FOLLOW')).toBe(true)
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
    byTweet: {
      t1: [
        { campaignId: 'cA', actionType: 'LIKE' },
        { campaignId: 'cB', actionType: 'RT' },
      ],
      t2: [{ campaignId: 'cC', actionType: 'COMMENT_LIKE' }],
    },
    byAuthor: {
      alicekol: [{ campaignId: 'cF', actionType: 'FOLLOW' }],
    },
  }
  it('单命中(tweet)', () => {
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
  it('FOLLOW 走 byAuthor(handle 大小写不敏感)', () => {
    expect(
      mapCaptureToCampaigns(
        { actionType: 'FOLLOW', handle: 'AliceKOL' },
        snapshot,
      ),
    ).toEqual([{ campaignId: 'cF', actionType: 'FOLLOW', handle: 'AliceKOL' }])
  })
  it('无匹配 / 缺 tweetId 或 handle → 空', () => {
    expect(
      mapCaptureToCampaigns({ actionType: 'RT', tweetId: 't2' }, snapshot),
    ).toEqual([])
    expect(mapCaptureToCampaigns({ actionType: 'LIKE' }, snapshot)).toEqual([])
    expect(mapCaptureToCampaigns({ actionType: 'FOLLOW' }, snapshot)).toEqual(
      [],
    )
    expect(
      mapCaptureToCampaigns(
        { actionType: 'FOLLOW', handle: 'nobody' },
        snapshot,
      ),
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
  it('FOLLOW 无 tweetId 也能累积', () => {
    expect(
      mergeAction(undefined, { actionType: 'FOLLOW', capturedAt: 'a' }),
    ).toEqual([{ actionType: 'FOLLOW', capturedAt: 'a' }])
  })
})

describe('successful GraphQL capture shared by fetch and XHR', () => {
  const request = body({
    tweet_id: '123',
    reply: { in_reply_to_tweet_id: '123' },
    tweet_text: 'gm',
  })
  it.each([
    'FavoriteTweet',
    'CreateRetweet',
    'CreateTweet',
    'CreateNoteTweet',
  ])('%s rejects HTTP 200 GraphQL errors, including partial data', (op) => {
    for (const response of [
      { errors: [{ message: 'denied' }] },
      {
        data: {
          create_tweet: { tweet_results: { result: { rest_id: '456' } } },
        },
        errors: [{ message: 'failed' }],
      },
    ]) {
      expect(extractSuccessfulCapturedAction(op, request, response)).toBeNull()
    }
  })
  it('preserves successful actions and existing missing-response behavior', () => {
    for (const response of [undefined, {}, { data: {}, errors: [] }]) {
      expect(
        extractSuccessfulCapturedAction('FavoriteTweet', request, response),
      ).toEqual({ actionType: 'LIKE', tweetId: '123' })
    }
    expect(
      extractSuccessfulCapturedAction('CreateTweet', request, {
        data: {
          create_tweet: { tweet_results: { result: { rest_id: '456' } } },
        },
      }),
    ).toEqual({
      actionType: 'COMMENT',
      tweetId: '123',
      commentText: 'gm',
      resultTweetId: '456',
    })
  })
})

describe('multi-action mapping and accumulation', () => {
  const actions: Record<string, CapturedAction> = {
    COMMENT: {
      actionType: 'COMMENT',
      tweetId: '123',
      commentText: 'original text',
      resultTweetId: '456',
    },
    RT: { actionType: 'RT', tweetId: '123' },
    FOLLOW: { actionType: 'FOLLOW', handle: 'alice' },
    LIKE: { actionType: 'LIKE', tweetId: '123' },
  }
  it.each([
    ['COMMENT', 'RT', 'FOLLOW'],
    ['COMMENT', 'FOLLOW', 'RT'],
    ['RT', 'COMMENT', 'FOLLOW'],
    ['RT', 'FOLLOW', 'COMMENT'],
    ['FOLLOW', 'COMMENT', 'RT'],
    ['FOLLOW', 'RT', 'COMMENT'],
  ])('accumulates %s → %s → %s without LIKE', (...order) => {
    const snapshot = {
      byTweet: {
        '123': ['COMMENT', 'RT'].map((actionType) => ({
          campaignId: 'combo',
          actionType,
        })),
      },
      byAuthor: { alice: [{ campaignId: 'combo', actionType: 'FOLLOW' }] },
    }
    let accumulated: ReportedAction[] = []
    for (const [index, key] of order.entries()) {
      const mapped = mapCaptureToCampaigns(actions[key], snapshot)
      expect(mapped).toHaveLength(1)
      accumulated = mergeAction(accumulated, {
        ...mapped[0],
        capturedAt: 'time',
      })
      expect(accumulated).toHaveLength(index + 1)
    }
    expect(accumulated.map((a) => a.actionType).sort()).toEqual([
      'COMMENT',
      'FOLLOW',
      'RT',
    ])
    expect(accumulated.find((a) => a.actionType === 'COMMENT')).toMatchObject(
      actions.COMMENT,
    )
    expect(
      accumulated.find((a) => a.actionType === 'FOLLOW'),
    ).not.toHaveProperty('tweetId')
    expect(mapCaptureToCampaigns(actions.LIKE, snapshot)).toEqual([])
  })
  it.each([
    ['COMMENT', 'LIKE'],
    ['LIKE', 'COMMENT'],
  ])('COMMENT_LIKE retains independent %s then %s evidence', (first, second) => {
    const snapshot = {
      byTweet: { '123': [{ campaignId: 'combo', actionType: 'COMMENT_LIKE' }] },
      byAuthor: {},
    }
    let accumulated: ReportedAction[] = []
    for (const key of [first, second, first]) {
      const [mapped] = mapCaptureToCampaigns(actions[key], snapshot)
      accumulated = mergeAction(accumulated, { ...mapped, capturedAt: 'time' })
      expect(accumulated.map((a) => a.actionType)).not.toContain('COMMENT_LIKE')
    }
    expect(accumulated).toHaveLength(2)
    expect(accumulated.find((a) => a.actionType === 'COMMENT')).toMatchObject(
      actions.COMMENT,
    )
  })
})
