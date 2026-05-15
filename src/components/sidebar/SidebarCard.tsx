import * as React from 'react'
import { WEB_ENDPOINT } from '@/lib/env'
import { sendMessage } from '@/lib/messaging'
import type { TweetCampaignSummary, UserProfile } from '@/lib/storage'

/**
 * Sidebar 卡片 v2 — Twitter 内的 Lighthouse mini-dashboard
 *
 * 信息架构(从上到下):
 *   ① 身份 strip — Logo + brand + Tier chip
 *   ② 指标 row   — 余额 (P0 大字) + 今日 (P2 小字)
 *   ③ 主 CTA     — [+ 发布任务] 跳 lhdao.top/campaigns/create
 *   ─ hairline ─
 *   ④ section 头 — "可抢推文任务 · N"
 *   ⑤ 任务行 × N  — 项目方 / brief 2 行 / 截止时间 / 奖励
 *   ⑥ footer    — "查看全部 N 个 →"(>5 任务时)
 *
 * 6 个状态:default / dark(CSS prefers-color-scheme) / empty / loading
 * / 5+ tasks(showing footer) / unauth(token 没配置)。
 *
 * 设计 spec 见 docs/sidebar-card-design.md
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

  const refresh = React.useCallback(async () => {
    const r = await sendMessage({ type: 'get-sidebar-data' })
    if (r.type === 'sidebar-data') {
      setData({
        profile: r.profile,
        tweetCampaigns: r.tweetCampaigns,
        tokenConfigured: r.tokenConfigured,
      })
      setLoading(false)
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

  // 未配置 token → 极简降级态(不展示空头部 + 空指标行)
  if (!data.tokenConfigured) {
    return <UnauthCard />
  }

  // 初次加载中 → skeleton
  if (loading) {
    return <LoadingCard />
  }

  const campaigns = data.tweetCampaigns ?? []
  const visibleTasks = campaigns.slice(0, VISIBLE_TASK_LIMIT)
  const hasMore = campaigns.length > VISIBLE_TASK_LIMIT

  return (
    <section className="lh-card">
      <IdentityStrip profile={data.profile} />
      <MetricRow profile={data.profile} />
      <CtaRow />
      {visibleTasks.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <SectionHeader count={campaigns.length} />
          <ul className="lh-list">
            {visibleTasks.map((c) => (
              <TaskRow key={c.campaignId} task={c} />
            ))}
          </ul>
          {hasMore && (
            <a
              className="lh-footer"
              href={`${WEB_ENDPOINT}/campaigns`}
              target="_blank"
              rel="noreferrer"
            >
              查看全部 {campaigns.length} 个 →
            </a>
          )}
        </>
      )}
    </section>
  )
}

// ── ① Identity strip ────────────────────────────────────────────────

function IdentityStrip({ profile }: { profile: UserProfile | null }) {
  return (
    <div className="lh-strip">
      <Logo />
      <span className="lh-brand">灯塔任务</span>
      {profile?.tier && <span className="lh-tier">TIER {profile.tier}</span>}
    </div>
  )
}

// ── ② Metric row (balance + today) ──────────────────────────────────

function MetricRow({ profile }: { profile: UserProfile | null }) {
  const balance = profile?.newLux ?? null
  const today = profile?.todayEarnings ?? null

  return (
    <div className="lh-metric">
      <span className="lh-metric-label">可用余额</span>
      <div className="lh-balance">
        <span className="lh-balance-num">{formatBalance(balance)}</span>
        <span className="lh-balance-unit">LUX</span>
      </div>
      <div className="lh-today">今日 {formatToday(today)} LUX</div>
    </div>
  )
}

// ── ③ Main CTA — 发布任务 ────────────────────────────────────────────

function CtaRow() {
  return (
    <div className="lh-cta-wrap">
      <a
        className="lh-cta"
        href={`${WEB_ENDPOINT}/campaigns/create`}
        target="_blank"
        rel="noreferrer"
      >
        <svg
          className="lh-cta-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <title>add</title>
          <path d="M12 5v14M5 12h14" />
        </svg>
        发布任务
      </a>
    </div>
  )
}

// ── ④ Section header ────────────────────────────────────────────────

function SectionHeader({ count }: { count: number }) {
  return (
    <div className="lh-section-header">
      可抢推文任务<span className="lh-section-count">· {count}</span>
    </div>
  )
}

// ── ⑤ Task row ──────────────────────────────────────────────────────

function TaskRow({ task }: { task: TweetCampaignSummary }) {
  const href = task.targetUrl ?? `${WEB_ENDPOINT}/campaigns/${task.campaignId}`
  const deadline = formatDeadline(task.submitClose)
  const isUrgent = deadline?.urgent ?? false

  return (
    <li>
      <a className="lh-row" href={href} target="_blank" rel="noreferrer">
        <div className="lh-row-body">
          <div className="lh-project">{task.projectName ?? '灯塔任务'}</div>
          <p className="lh-brief">{task.brief ?? '查看详情'}</p>
          {deadline && (
            <span
              className={
                isUrgent ? 'lh-deadline lh-deadline-urgent' : 'lh-deadline'
              }
            >
              <ClockIcon />
              {deadline.text}
            </span>
          )}
        </div>
        <div className="lh-reward">
          <span className="lh-reward-num">+{formatReward(task.rewardLux)}</span>
          <span className="lh-reward-unit">LUX</span>
        </div>
      </a>
    </li>
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
      <div className="lh-strip">
        <Logo />
        <span className="lh-brand">灯塔任务</span>
        <span className="lh-sk-block lh-sk-tier" />
      </div>
      <div className="lh-metric">
        <span className="lh-sk-block lh-sk-label" />
        <div className="lh-sk-block lh-sk-balance" />
        <div className="lh-sk-block lh-sk-today" />
      </div>
      <div className="lh-cta-wrap">
        <div className="lh-sk-block lh-sk-cta" />
      </div>
      <div className="lh-section-header">
        可抢推文任务<span className="lh-section-count">· …</span>
      </div>
      <ul className="lh-list">
        {[1, 2, 3].map((i) => (
          <li key={i} className="lh-sk-row">
            <div className="lh-sk-rowbody">
              <span className="lh-sk-block lh-sk-project" />
              <span className="lh-sk-block lh-sk-brief1" />
              <span className="lh-sk-block lh-sk-brief2" />
              <span className="lh-sk-block lh-sk-deadline" />
            </div>
            <span className="lh-sk-block lh-sk-reward" />
          </li>
        ))}
      </ul>
    </section>
  )
}

// ── Unauth (token 没配置) ──────────────────────────────────────────

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
      <div className="lh-strip">
        <Logo />
        <span className="lh-brand">灯塔任务</span>
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
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ width: 12, height: 12 }}
            aria-hidden="true"
          >
            <title>arrow</title>
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </a>
      </div>
    </section>
  )
}

// ── Logo (PNG fallback to inline SVG) ───────────────────────────────

function Logo() {
  const [src, setSrc] = React.useState<string | null>(() => {
    try {
      return chrome.runtime.getURL('icon/48.png')
    } catch {
      return null
    }
  })
  if (!src) {
    return <LogoFallback />
  }
  return (
    <span className="lh-logo">
      <img
        src={src}
        alt="Lighthouse"
        className="lh-logo-img"
        width={20}
        height={20}
        onError={() => setSrc(null)}
      />
    </span>
  )
}

function LogoFallback() {
  return (
    <span className="lh-logo">
      <svg viewBox="0 0 40 40" width={20} height={20} aria-hidden="true">
        <title>Lighthouse</title>
        <path d="M20 8 L13 16 H16 V30 H24 V16 H27 Z" fill="white" />
        <circle cx="20" cy="33" r="1.8" fill="white" opacity="0.85" />
      </svg>
    </span>
  )
}

// ── Icons ───────────────────────────────────────────────────────────

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <title>clock</title>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  )
}

// ── Formatters ──────────────────────────────────────────────────────

/** 余额数字格式化:整数千分位,小数最多一位 */
function formatBalance(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  const display = Number.isInteger(n) ? n : Number(n.toFixed(1))
  return `+${display.toLocaleString('en-US')}`
}

/** 今日收益格式化:可以是 0(显示 +0)或小数 */
function formatToday(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—'
  if (n === 0) return '+0'
  const display = Number.isInteger(n) ? n : Number(n.toFixed(1))
  return `+${display.toLocaleString('en-US')}`
}

/** 奖励数字格式化:任务行用,无千分位以省空间 */
function formatReward(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (Number.isInteger(n)) return String(n)
  return Number(n.toFixed(1)).toString()
}

/**
 * 截止时间格式化:
 *   - <1h        → "Xm 后",紧急
 *   - 1-6h       → "Xh 后",紧急
 *   - 6-24h      → "Xh 后",非紧急
 *   - 1-7d       → "Xd 后",非紧急
 *   - >7d        → "M-d",非紧急(避免显示"30d 后"这种没体感的)
 *   - 已过期 / null → null(不渲染)
 */
function formatDeadline(
  iso: string | null,
): { text: string; urgent: boolean } | null {
  if (!iso) return null
  const target = new Date(iso).getTime()
  if (!Number.isFinite(target)) return null
  const now = Date.now()
  const diffMs = target - now
  if (diffMs <= 0) return null

  const diffHours = diffMs / (1000 * 60 * 60)
  const diffDays = diffHours / 24

  if (diffHours < 1) {
    const mins = Math.max(1, Math.round(diffMs / (1000 * 60)))
    return { text: `截止 ${mins}m 后`, urgent: true }
  }
  if (diffHours < 6) {
    return { text: `截止 ${Math.floor(diffHours)}h 后`, urgent: true }
  }
  if (diffHours < 24) {
    return { text: `截止 ${Math.floor(diffHours)}h 后`, urgent: false }
  }
  if (diffDays < 7) {
    return { text: `截止 ${Math.floor(diffDays)}d 后`, urgent: false }
  }
  // >7 天:用日期更可读
  const d = new Date(iso)
  return {
    text: `截止 ${d.getMonth() + 1}-${d.getDate()}`,
    urgent: false,
  }
}
