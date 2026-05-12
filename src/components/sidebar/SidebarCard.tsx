import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import type { ActiveCampaignSummary, CampaignTaskCache } from '@/lib/storage'

/**
 * Sidebar 卡片 — 注入 Twitter 右侧 sidebar 顶部 (订阅 Premium 卡片
 * 上方),展示当前用户可抢的 ENGAGEMENT campaign 列表。
 *
 * 数据流:
 *   1. mount 时 sendMessage('get-active-campaigns') 拉 background 缓存
 *   2. 监听 chrome.runtime.onMessage 'tasks-updated' 广播 → 重拉
 *   3. 点 item → SPA navigate 到该推文详情页 (Twitter 自身处理 pushState)
 *
 * UI:
 *   - 头部:标题 + 任务数 pill
 *   - 列表:头像 + 名字 + 动作 chips + 奖励 LUX (右对齐)
 *   - 空列表时**不挂载**(content.ts 控制),所以这里不写 empty state
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

  const totalLux = campaigns.reduce((acc, c) => acc + c.rewardLux, 0)

  return (
    <section className="lhdao-sidebar-card">
      <header className="lhdao-sidebar-card-header">
        <span className="lhdao-sidebar-card-title">
          <LighthouseGlyph />
          灯塔任务
        </span>
        <span className="lhdao-sidebar-card-pill">
          {campaigns.length} 个 · +{fmt(totalLux)} LUX
        </span>
      </header>
      <ul className="lhdao-sidebar-card-list">
        {campaigns.slice(0, 5).map((c) => (
          <SidebarRow key={c.campaignId} campaign={c} />
        ))}
      </ul>
      {campaigns.length > 5 && (
        <a
          className="lhdao-sidebar-card-more"
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
  // 点击行 = 在当前 tab 跳到该推文详情页。<a href> 让 Twitter 自家
  // click 委托接管做 SPA navigate (避免整页 reload),失败也能 fall back
  // 到正常导航。
  const inner = (
    <>
      <Avatar src={campaign.authorAvatar} alt={campaign.authorName ?? ''} />
      <div className="lhdao-sidebar-row-text">
        <div className="lhdao-sidebar-row-name">
          {campaign.authorName ?? '推文'}
          {campaign.authorHandle && (
            <span className="lhdao-sidebar-row-handle">
              @{campaign.authorHandle}
            </span>
          )}
        </div>
        <div className="lhdao-sidebar-row-meta">
          {campaign.actionTypes.map((t) => (
            <span key={t} className="lhdao-sidebar-action-chip">
              {actionLabel(t)}
            </span>
          ))}
          {campaign.commentKeyword && (
            <span
              className="lhdao-sidebar-row-keyword"
              title={`评论需含 ${campaign.commentKeyword}`}
            >
              #{campaign.commentKeyword}
            </span>
          )}
        </div>
      </div>
      <div className="lhdao-sidebar-row-reward">
        <span className="lhdao-sidebar-row-reward-num">
          +{fmt(campaign.rewardLux)}
        </span>
        <span className="lhdao-sidebar-row-reward-unit">LUX</span>
      </div>
    </>
  )

  // 解析 targetUrl 转成相对路径 (避免 cross-origin) 让 Twitter SPA 接管
  let href = campaign.targetUrl
  try {
    const u = new URL(campaign.targetUrl)
    href = u.pathname + u.search
  } catch {
    // fallback to original
  }

  return (
    <li className="lhdao-sidebar-row">
      <a className="lhdao-sidebar-row-link" href={href}>
        {inner}
      </a>
    </li>
  )
}

function Avatar({ src, alt }: { src: string | null; alt: string }) {
  // 没头像就显示一个 teal 渐变占位 (跟 popup / chip 同色)
  if (!src) {
    return (
      <div
        className="lhdao-sidebar-avatar"
        style={{
          background:
            'linear-gradient(135deg, oklch(0.78 0.11 195), oklch(0.83 0.1 215))',
        }}
      />
    )
  }
  return (
    <img
      className="lhdao-sidebar-avatar"
      src={src}
      alt={alt}
      loading="lazy"
      referrerPolicy="no-referrer"
    />
  )
}

function actionLabel(t: CampaignTaskCache['actionType']): string {
  switch (t) {
    case 'LIKE':
      return '❤ 赞'
    case 'RT':
      return '↺ 转'
    case 'COMMENT':
      return '💬 评'
    case 'COMMENT_LIKE':
      return '💬+❤'
  }
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(1)).toString()
}

function LighthouseGlyph() {
  return (
    <svg
      viewBox="0 0 16 16"
      width={14}
      height={14}
      aria-hidden="true"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    >
      <title>Lighthouse</title>
      <path
        d="M8 1 L4 5 H6 V13 H10 V5 H12 Z"
        fill="currentColor"
        opacity="0.95"
      />
      <circle cx="8" cy="14.5" r="1" fill="currentColor" opacity="0.7" />
    </svg>
  )
}
