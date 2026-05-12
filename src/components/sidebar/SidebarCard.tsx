import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import type { ActiveCampaignSummary, CampaignTaskCache } from '@/lib/storage'

/**
 * Sidebar 卡片 — 注入 Twitter 右侧 sidebar 顶部 (订阅 Premium 卡片
 * 上方),展示当前用户可抢的 ENGAGEMENT campaign 列表。
 *
 * 信息层级 (从重到轻):
 *   ① 奖励数额 (右侧大字 teal)
 *   ② 作者 + handle (中部首行)
 *   ③ 推文正文预览 (1 行截断,鼠标 hover 看全)
 *   ④ 动作类型 (小图标 + 文字)
 *
 * 空 list 不挂载 (content.ts 控制),所以这里不写 empty state。
 */
export function SidebarCard() {
  const [campaigns, setCampaigns] = React.useState<ActiveCampaignSummary[]>([])

  const refresh = React.useCallback(async () => {
    const r = await sendMessage({ type: 'get-active-campaigns' })
    if (r.type === 'active-campaigns') setCampaigns(r.campaigns)
  }, [])

  React.useEffect(() => {
    void refresh()
    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'tasks-updated') void refresh()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [refresh])

  if (campaigns.length === 0) return null

  return (
    <section className="lhdao-card">
      <header className="lhdao-card-header">
        <Logo />
        <div className="lhdao-card-title-wrap">
          <h2 className="lhdao-card-title">灯塔任务</h2>
          <p className="lhdao-card-subtitle">
            {campaigns.length} 个可抢 · 奖励 LUX
          </p>
        </div>
      </header>
      <ul className="lhdao-card-list">
        {campaigns.slice(0, 5).map((c) => (
          <SidebarRow key={c.campaignId} campaign={c} />
        ))}
      </ul>
      {campaigns.length > 5 && (
        <a
          className="lhdao-card-footer-link"
          href="https://lhdao.top/campaigns"
          target="_blank"
          rel="noreferrer"
        >
          查看全部 {campaigns.length} 个 →
        </a>
      )}
    </section>
  )
}

function SidebarRow({ campaign }: { campaign: ActiveCampaignSummary }) {
  // targetUrl 转成相对路径让 Twitter SPA 接管 (不刷整页)
  let href = campaign.targetUrl
  try {
    const u = new URL(campaign.targetUrl)
    href = u.pathname + u.search
  } catch {
    // ignore
  }

  return (
    <li className="lhdao-card-row">
      <a className="lhdao-card-row-link" href={href}>
        <Avatar src={campaign.authorAvatar} alt={campaign.authorName ?? ''} />
        <div className="lhdao-card-row-body">
          <div className="lhdao-card-row-name">
            {campaign.authorName ?? '推文'}
            {campaign.authorHandle && (
              <span className="lhdao-card-row-handle">
                @{campaign.authorHandle}
              </span>
            )}
          </div>
          {campaign.tweetPreview && (
            <p className="lhdao-card-row-preview" title={campaign.tweetPreview}>
              {campaign.tweetPreview}
            </p>
          )}
          <div className="lhdao-card-row-actions">
            {campaign.actionTypes.map((t) => (
              <span key={t} className="lhdao-card-action-chip">
                <ActionIcon type={t} />
                {actionLabel(t)}
              </span>
            ))}
            {campaign.commentKeyword && (
              <span
                className="lhdao-card-keyword"
                title={`评论需包含 ${campaign.commentKeyword}`}
              >
                #{campaign.commentKeyword}
              </span>
            )}
          </div>
        </div>
        <div className="lhdao-card-row-reward">
          <span className="lhdao-card-row-reward-num">
            +{fmt(campaign.rewardLux)}
          </span>
          <span className="lhdao-card-row-reward-unit">LUX</span>
        </div>
      </a>
    </li>
  )
}

// ── Logo (with PNG fallback to inline SVG) ─────────────────────────

function Logo() {
  const [src, setSrc] = React.useState<string | null>(() => {
    try {
      return chrome.runtime.getURL('icon/48.png')
    } catch {
      return null
    }
  })
  if (!src) return <LogoFallback />
  return (
    <img
      src={src}
      alt="Lighthouse"
      className="lhdao-card-logo"
      width={28}
      height={28}
      onError={() => setSrc(null)}
    />
  )
}

/**
 * Inline 兜底 logo — 用户没跑 `pnpm run icons` / public/icon 未生成时使用。
 * 紫底 + teal-cyan 渐变 "L" 字样的极简圆 mark。
 */
function LogoFallback() {
  return (
    <div className="lhdao-card-logo lhdao-card-logo-fallback">
      <svg viewBox="0 0 40 40" width={28} height={28} aria-hidden="true">
        <title>Lighthouse</title>
        <defs>
          <linearGradient id="lhdao-lg" x1="0" y1="0" x2="40" y2="40">
            <stop offset="0%" stopColor="oklch(0.65 0.13 195)" />
            <stop offset="100%" stopColor="oklch(0.72 0.13 215)" />
          </linearGradient>
        </defs>
        <circle cx="20" cy="20" r="20" fill="url(#lhdao-lg)" />
        <path d="M20 8 L13 16 H16 V30 H24 V16 H27 Z" fill="white" />
        <circle cx="20" cy="33" r="2" fill="white" opacity="0.85" />
      </svg>
    </div>
  )
}

// ── Avatar (image with gradient placeholder fallback) ───────────────

function Avatar({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = React.useState(false)
  if (!src || errored) {
    return (
      <div
        className="lhdao-card-avatar lhdao-card-avatar-placeholder"
        role="img"
        aria-label={alt || 'avatar placeholder'}
      />
    )
  }
  return (
    <img
      className="lhdao-card-avatar"
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
    />
  )
}

// ── Action icons (heart / repeat / comment) ─────────────────────────

function ActionIcon({ type }: { type: CampaignTaskCache['actionType'] }) {
  const cls = 'lhdao-card-action-icon'
  if (type === 'LIKE') {
    return (
      <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
        <title>Like</title>
        <path
          d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l8.84 8.84 8.84-8.84a5.5 5.5 0 0 0 0-7.78z"
          fill="currentColor"
        />
      </svg>
    )
  }
  if (type === 'RT') {
    return (
      <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
        <title>Retweet</title>
        <path
          d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  // COMMENT or COMMENT_LIKE
  return (
    <svg viewBox="0 0 24 24" className={cls} aria-hidden="true">
      <title>Comment</title>
      <path
        d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function actionLabel(t: CampaignTaskCache['actionType']): string {
  switch (t) {
    case 'LIKE':
      return '点赞'
    case 'RT':
      return '转发'
    case 'COMMENT':
      return '评论'
    case 'COMMENT_LIKE':
      return '评+赞'
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(1)).toString()
}
