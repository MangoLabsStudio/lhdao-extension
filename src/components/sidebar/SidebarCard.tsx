import * as React from 'react'
import { WEB_ENDPOINT } from '@/lib/env'
import { sendMessage } from '@/lib/messaging'
import type { TweetCampaignSummary, UserProfile } from '@/lib/storage'

/**
 * Sidebar 卡片 v3 — Lighthouse mini-dashboard 嵌入 X 右侧栏
 *
 * 视觉规范跟 Chrome Web Store screenshot-2-sidebar.png 1:1 一致:
 *   ① 顶部 brand bar      — burst icon + LIGHTHOUSE + synced N s ago
 *   ② identity 内嵌卡片   — 头像 / name / @handle / TIER chip + 大字余额 + today delta
 *   ③ LIVE TASKS eyebrow  — 小字 + 匹配数 + auto-refresh 60s
 *   ④ task rows           — color-coded icon + author + brief + +X.X LUX
 *   ⑤ footer stats        — 3 个微指标(TASKS LIVE / TODAY / TIER)
 *   ⑥ 发布任务 CTA        — 卡片底部按钮
 *
 * 颜色 token 走 OKLCH,brand teal + cyan accent。Shadow DOM 隔离,Twitter
 * CSS 不会污染进来。
 */

interface SidebarData {
  profile: UserProfile | null
  tweetCampaigns: TweetCampaignSummary[] | null
  tokenConfigured: boolean
}

const INITIAL: SidebarData = {
  profile: null,
  tweetCampaigns: null,
  tokenConfigured: false,
}

const VISIBLE_TASK_LIMIT = 5

export function SidebarCard() {
  const [data, setData] = React.useState<SidebarData>(INITIAL)
  const [loading, setLoading] = React.useState(true)
  const [lastSyncAt, setLastSyncAt] = React.useState<number>(Date.now())

  const refresh = React.useCallback(async () => {
    const r = await sendMessage({ type: 'get-sidebar-data' })
    if (r.type === 'sidebar-data') {
      setData({
        profile: r.profile,
        tweetCampaigns: r.tweetCampaigns,
        tokenConfigured: r.tokenConfigured,
      })
      setLoading(false)
      setLastSyncAt(Date.now())
    }
  }, [])

  React.useEffect(() => {
    void refresh()
    const listener = (msg: { type?: string }) => {
      if (msg?.type === 'tasks-updated') void refresh()
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [refresh])

  if (!data.tokenConfigured) {
    return <UnauthCard />
  }
  if (loading) {
    return <LoadingCard />
  }

  const campaigns = data.tweetCampaigns ?? []
  const visibleTasks = campaigns.slice(0, VISIBLE_TASK_LIMIT)
  const hasMore = campaigns.length > VISIBLE_TASK_LIMIT

  return (
    <section className="lh-card">
      <BrandBar lastSyncAt={lastSyncAt} />
      <IdentityCard profile={data.profile} />
      <SectionHeader count={campaigns.length} />
      {visibleTasks.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="lh-tasks">
          {visibleTasks.map((c) => (
            <TaskRow key={c.campaignId} task={c} />
          ))}
        </ul>
      )}
      {hasMore && (
        <a
          className="lh-list-more"
          href={`${WEB_ENDPOINT}/campaigns`}
          target="_blank"
          rel="noreferrer"
        >
          查看全部 {campaigns.length} 个 →
        </a>
      )}
      <FooterStats profile={data.profile} taskCount={campaigns.length} />
      <CtaRow />
    </section>
  )
}

// ── ① Brand bar ─────────────────────────────────────────────────────

function BrandBar({ lastSyncAt }: { lastSyncAt: number }) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(id)
  }, [])
  const ago = formatSyncAgo(now - lastSyncAt)

  return (
    <div className="lh-brand-bar">
      <BurstIcon size={20} />
      <span className="lh-brand-name">LIGHTHOUSE</span>
      <span className="lh-sync">
        <span className="lh-sync-dot" />
        synced {ago}
      </span>
    </div>
  )
}

// ── ② Identity card — 内嵌 teal-tinted box ──────────────────────────

function IdentityCard({ profile }: { profile: UserProfile | null }) {
  const name = profile?.displayName ?? '灯塔任务'
  const handle = profile?.twitterHandle ?? null
  const balance = profile?.newLux ?? null
  const today = profile?.todayEarnings ?? null

  return (
    <div className="lh-identity">
      <div className="lh-identity-row">
        <UserAvatar src={profile?.avatar ?? null} alt={name} />
        <div className="lh-identity-meta">
          <div className="lh-identity-name">{name}</div>
          {handle && <div className="lh-identity-handle">@{handle}</div>}
        </div>
        {profile?.tier && (
          <span className="lh-tier-chip">TIER {profile.tier}</span>
        )}
      </div>
      <div className="lh-balance-row">
        <span className="lh-balance-num">{formatBalance(balance)}</span>
        <span className="lh-balance-unit">LUX</span>
        {today != null && today > 0 && (
          <span className="lh-today-delta">
            <UpIcon />
            +{formatToday(today)} today
          </span>
        )}
      </div>
    </div>
  )
}

function UserAvatar({ src, alt }: { src: string | null; alt: string }) {
  const [errored, setErrored] = React.useState(false)
  if (!src || errored) {
    // Fallback: 灯塔品牌色 gradient + 第一个字母
    const initial = alt?.[0]?.toUpperCase() ?? 'L'
    return (
      <span
        className="lh-avatar lh-avatar-fallback"
        role="img"
        aria-label={alt}
      >
        {initial}
      </span>
    )
  }
  return (
    <img
      className="lh-avatar"
      src={src}
      alt={alt}
      width={40}
      height={40}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
    />
  )
}

// ── ③ Section header ────────────────────────────────────────────────

function SectionHeader({ count }: { count: number }) {
  return (
    <div className="lh-section">
      <span className="lh-section-label">LIVE TASKS</span>
      <span className="lh-section-meta">
        {count} matching · auto-refresh 60s
      </span>
    </div>
  )
}

// ── ④ Task row ──────────────────────────────────────────────────────

function TaskRow({ task }: { task: TweetCampaignSummary }) {
  const href = task.targetUrl ?? `${WEB_ENDPOINT}/campaigns/${task.campaignId}`

  return (
    <li>
      <a className="lh-task" href={href} target="_blank" rel="noreferrer">
        <span className="lh-task-icon lh-task-icon-tweet">
          <TweetIcon />
        </span>
        <div className="lh-task-mid">
          <div className="lh-task-author">
            {task.projectName ?? '灯塔任务'}
          </div>
          <div className="lh-task-sub">{task.brief ?? '查看详情'}</div>
        </div>
        <div className="lh-task-reward">
          +{formatReward(task.rewardLux)}
          <span className="lh-task-reward-unit">LUX</span>
        </div>
      </a>
    </li>
  )
}

// ── ⑤ Footer stats — 3 个微指标 ────────────────────────────────────

function FooterStats({
  profile,
  taskCount,
}: {
  profile: UserProfile | null
  taskCount: number
}) {
  const today = profile?.todayEarnings ?? null
  return (
    <div className="lh-foot">
      <FooterStatCell label="TASKS LIVE" value={taskCount.toString()} />
      <FooterStatCell
        label="TODAY"
        value={today != null && today > 0 ? `+${formatToday(today)}` : '+0'}
      />
      <FooterStatCell label="TIER" value={profile?.tier ?? '—'} />
    </div>
  )
}

function FooterStatCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="lh-foot-cell">
      <span className="lh-foot-label">{label}</span>
      <span className="lh-foot-value">{value}</span>
    </div>
  )
}

// ── ⑥ CTA — 发布任务 ────────────────────────────────────────────────

function CtaRow() {
  return (
    <div className="lh-cta-wrap">
      <a
        className="lh-cta"
        href={`${WEB_ENDPOINT}/campaigns/create`}
        target="_blank"
        rel="noreferrer"
      >
        <PlusIcon />
        发布任务
      </a>
    </div>
  )
}

// ── Empty state ─────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="lh-empty">
      <span className="lh-empty-dot" aria-hidden="true" />
      <p className="lh-empty-title">暂无可抢推文任务</p>
      <p className="lh-empty-hint">新机会出现时会自动显示在这里</p>
    </div>
  )
}

// ── Loading skeleton ────────────────────────────────────────────────

function LoadingCard() {
  return (
    <section className="lh-card">
      <div className="lh-brand-bar">
        <BurstIcon size={20} />
        <span className="lh-brand-name">LIGHTHOUSE</span>
        <span className="lh-sync">
          <span className="lh-sync-dot" />
          loading…
        </span>
      </div>
      <div className="lh-identity">
        <div className="lh-identity-row">
          <span className="lh-sk lh-sk-avatar" />
          <div className="lh-identity-meta">
            <span className="lh-sk lh-sk-line" style={{ width: 90 }} />
            <span className="lh-sk lh-sk-line" style={{ width: 60 }} />
          </div>
          <span className="lh-sk lh-sk-tier" />
        </div>
        <div className="lh-balance-row">
          <span className="lh-sk lh-sk-balance" />
        </div>
      </div>
      <div className="lh-section">
        <span className="lh-section-label">LIVE TASKS</span>
        <span className="lh-section-meta">…</span>
      </div>
      <ul className="lh-tasks">
        {[1, 2, 3].map((i) => (
          <li key={i} className="lh-task lh-task-sk">
            <span className="lh-sk lh-sk-icon" />
            <div className="lh-task-mid">
              <span className="lh-sk lh-sk-line" style={{ width: 70 }} />
              <span className="lh-sk lh-sk-line" style={{ width: 140 }} />
            </div>
            <span className="lh-sk lh-sk-reward" />
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── Unauth state ────────────────────────────────────────────────────

function UnauthCard() {
  const optionsUrl = (() => {
    try {
      return chrome.runtime.getURL('options.html')
    } catch {
      return '#'
    }
  })()

  return (
    <section className="lh-card">
      <div className="lh-brand-bar">
        <BurstIcon size={20} />
        <span className="lh-brand-name">LIGHTHOUSE</span>
      </div>
      <div className="lh-unauth">
        <p className="lh-unauth-title">尚未连接 Lighthouse 账号</p>
        <p className="lh-unauth-hint">
          在插件 options 页粘贴 plugin token
          <br />
          解锁余额、任务列表与发布任务
        </p>
        <a
          className="lh-unauth-btn"
          href={optionsUrl}
          target="_blank"
          rel="noreferrer"
        >
          配置 token
          <ArrowIcon />
        </a>
      </div>
    </section>
  )
}

// ── Icons ───────────────────────────────────────────────────────────

/**
 * Brand burst icon — 4 个 elongated X-form blade + 中心 beacon。
 * 跟 store-assets / kol-dao-app/public/brand/burst-icon.svg 完全一致。
 */
function BurstIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
      className="lh-burst"
    >
      <title>Lighthouse</title>
      <g fill="#5EEAD4">
        <path d="M16,16 L28.5,3.5 L28.5,9 L19,15 Z" />
        <path d="M16,16 L3.5,3.5 L3.5,9 L13,15 Z" />
        <path d="M16,16 L26,26 L26,22 L19,17 Z" />
        <path d="M16,16 L6,26 L6,22 L13,17 Z" />
      </g>
      <circle cx="16" cy="16" r="3" fill="#08090F" />
      <circle cx="16" cy="16" r="1.8" fill="#00f5d4" />
      <circle cx="16" cy="16" r="0.9" fill="#fff" />
    </svg>
  )
}

function TweetIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <title>tweet</title>
      <path
        d="M22 5.79c-.74.33-1.54.55-2.36.65a4.12 4.12 0 0 0 1.81-2.27 8.18 8.18 0 0 1-2.6.99 4.1 4.1 0 0 0-7.08 3.74A11.65 11.65 0 0 1 3.4 4.59a4.1 4.1 0 0 0 1.27 5.48A4.07 4.07 0 0 1 2.8 9.6v.05a4.1 4.1 0 0 0 3.29 4.02 4.13 4.13 0 0 1-1.85.07A4.1 4.1 0 0 0 8.07 16.6 8.23 8.23 0 0 1 2 18.29a11.62 11.62 0 0 0 6.29 1.84c7.55 0 11.68-6.25 11.68-11.68 0-.18 0-.36-.01-.53A8.34 8.34 0 0 0 22 5.79z"
        fill="currentColor"
      />
    </svg>
  )
}

function UpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="11" height="11" aria-hidden="true">
      <title>up</title>
      <path
        d="M18 15l-6-6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <title>add</title>
      <path
        d="M12 5v14M5 12h14"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.6"
        strokeLinecap="round"
      />
    </svg>
  )
}

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
      <title>arrow</title>
      <path
        d="M5 12h14M13 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── Formatters ──────────────────────────────────────────────────────

function formatBalance(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const display = Number.isInteger(n) ? n : Number(n.toFixed(1))
  return display.toLocaleString('en-US')
}

function formatToday(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return Number(n.toFixed(1)).toLocaleString('en-US')
}

function formatReward(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(1)).toString()
}

function formatSyncAgo(diffMs: number): string {
  if (diffMs < 5_000) return 'just now'
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  return `${Math.floor(diffMs / 3_600_000)}h ago`
}
