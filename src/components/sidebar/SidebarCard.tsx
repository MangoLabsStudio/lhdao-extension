import * as React from 'react'
import { LighthouseSelectedText } from '@/components/lighthouse/LighthouseSelectedText'
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

  return (
    <section className="lh-card">
      <BrandBar lastSyncAt={lastSyncAt} />
      <IdentityCard profile={data.profile} />
      {/* 当前任务卡已改为内联到推文详情页动作栏下方(content.ts mountArticle),
          不再嵌在右栏卡里 —— 避免右栏被其它扩展/X 布局挤位。右栏卡现只留身份 +
          指标 + 发布任务入口。 */}
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
          {profile?.lighthouseSelected === true ? (
            <LighthouseSelectedText kind="current" />
          ) : null}
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
            <UpIcon />+{formatToday(today)} today
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
/**
 * Brand mark — 直接用 manifest 里 icon/128.png(favicon 派生)。
 * 跟主站 favicon / chrome 工具栏图标像素级一致,不做 SVG 复刻避免偏差。
 */
function BurstIcon({ size = 20 }: { size?: number }) {
  const src = React.useMemo(() => {
    try {
      return chrome.runtime.getURL('icon/128.png')
    } catch {
      return ''
    }
  }, [])
  return (
    <img
      src={src}
      width={size}
      height={size}
      alt="Lighthouse"
      className="lh-burst"
      style={{ display: 'inline-block' }}
    />
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

function formatSyncAgo(diffMs: number): string {
  if (diffMs < 5_000) return 'just now'
  if (diffMs < 60_000) return `${Math.floor(diffMs / 1000)}s ago`
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`
  return `${Math.floor(diffMs / 3_600_000)}h ago`
}
