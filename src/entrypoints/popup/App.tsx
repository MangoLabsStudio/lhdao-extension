import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import { type CampaignTaskCache, sessionStore } from '@/lib/storage'

interface PopupSummary {
  hasToken: boolean
  taskCount: number
  tweetCount: number
  lastSyncAt: number | null
}

/**
 * Toolbar popup — 320px 宽小窗,展示插件运行状态。
 * 不做实际操作,只显示概览 + 跳到 options 页 / lhdao 网站。
 */
export function App() {
  const [s, setS] = React.useState<PopupSummary | null>(null)

  const refresh = React.useCallback(async () => {
    const tokenStatus = await sendMessage({ type: 'has-token' })
    const map = (await sessionStore.get('tasksByTweetId')) ?? {}
    const lastSync = await sessionStore.get('lastSyncAt')
    let taskCount = 0
    let tweetCount = 0
    for (const arr of Object.values(map) as CampaignTaskCache[][]) {
      if (arr.length > 0) {
        tweetCount += 1
        taskCount += arr.length
      }
    }
    setS({
      hasToken:
        tokenStatus.type === 'token-status' ? tokenStatus.configured : false,
      taskCount,
      tweetCount,
      lastSyncAt: lastSync ?? null,
    })
  }, [])

  React.useEffect(() => {
    void refresh()
    const interval = setInterval(refresh, 5000)
    return () => clearInterval(interval)
  }, [refresh])

  const openOptions = () => {
    chrome.runtime.openOptionsPage()
  }
  const openWeb = () => {
    chrome.tabs.create({ url: 'https://lhdao.top/campaigns' })
  }

  return (
    <div className="px-4 pt-4 pb-3">
      <Header />
      {s === null ? (
        <SkeletonRow />
      ) : !s.hasToken ? (
        <NoTokenBlock onOpenOptions={openOptions} />
      ) : (
        <ActiveBlock summary={s} onOpenWeb={openWeb} onRefresh={refresh} />
      )}
      <Footer onOpenOptions={openOptions} />
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="flex items-center gap-2">
      <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-teal-500 to-cyan-500 text-white shadow-sm">
        <LighthouseGlyph />
      </span>
      <div className="min-w-0 flex-1">
        <h1 className="text-[13.5px] font-black tracking-tight text-slate-900 dark:text-slate-50">
          Lighthouse
        </h1>
        <p className="text-[10px] text-slate-500 dark:text-slate-400">
          灯塔浏览器插件
        </p>
      </div>
    </header>
  )
}

// ── No token state ───────────────────────────────────────────────────

function NoTokenBlock({ onOpenOptions }: { onOpenOptions: () => void }) {
  return (
    <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/40 dark:bg-amber-950/30">
      <p className="text-[11.5px] font-bold text-amber-900 dark:text-amber-200">
        未配置 token
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-amber-800/90 dark:text-amber-300/80">
        粘贴在 lhdao 网站创建的 plugin token,插件才能拉取并提交任务。
      </p>
      <button
        type="button"
        onClick={onOpenOptions}
        className="mt-2 inline-flex h-7 items-center gap-1 rounded-lg bg-amber-600 px-2.5 text-[11px] font-bold text-white shadow-sm transition hover:bg-amber-700"
      >
        去配置
      </button>
    </div>
  )
}

// ── Active state ─────────────────────────────────────────────────────

function ActiveBlock({
  summary,
  onOpenWeb,
  onRefresh,
}: {
  summary: PopupSummary
  onOpenWeb: () => void
  onRefresh: () => void
}) {
  return (
    <>
      {/* KPI grid */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <KpiCard label="活跃任务" value={summary.taskCount} accent />
        <KpiCard label="覆盖推文" value={summary.tweetCount} />
      </div>

      {/* Sync status */}
      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10.5px] dark:border-slate-800 dark:bg-slate-900">
        <span className="flex items-center gap-1.5 text-slate-500 dark:text-slate-400">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {summary.lastSyncAt
            ? `上次同步 ${fmtRelative(summary.lastSyncAt)}`
            : '尚未同步'}
        </span>
        <button
          type="button"
          onClick={onRefresh}
          className="text-teal-600 hover:underline dark:text-teal-400"
        >
          刷新
        </button>
      </div>

      {/* Open web */}
      <button
        type="button"
        onClick={onOpenWeb}
        className="mt-3 flex w-full items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-[11.5px] font-bold text-slate-700 transition hover:border-teal-300 hover:bg-teal-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-teal-800 dark:hover:bg-slate-800"
      >
        在 lhdao 浏览全部任务
        <ChevronIcon />
      </button>
    </>
  )
}

function KpiCard({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: boolean
}) {
  return (
    <div
      className={`rounded-xl border px-3 py-2.5 ${
        accent
          ? 'border-teal-200 bg-teal-50 dark:border-teal-900/40 dark:bg-teal-950/30'
          : 'border-slate-200 bg-slate-50 dark:border-slate-800 dark:bg-slate-900'
      }`}
    >
      <p className="text-[9.5px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
        {label}
      </p>
      <p
        className={`mt-1 text-[22px] font-black tabular-nums leading-none ${
          accent
            ? 'text-teal-700 dark:text-teal-300'
            : 'text-slate-900 dark:text-slate-50'
        }`}
      >
        {value}
      </p>
    </div>
  )
}

// ── Footer ───────────────────────────────────────────────────────────

function Footer({ onOpenOptions }: { onOpenOptions: () => void }) {
  return (
    <footer className="mt-4 border-t border-slate-200 pt-2 text-[10px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
      <button
        type="button"
        onClick={onOpenOptions}
        className="hover:text-teal-600 hover:underline dark:hover:text-teal-400"
      >
        设置
      </button>
      <span className="mx-1.5">·</span>
      <a
        href="https://github.com/MangoLabsStudio/lhdao-extension"
        target="_blank"
        rel="noreferrer"
        className="hover:text-teal-600 hover:underline dark:hover:text-teal-400"
      >
        GitHub
      </a>
      <span className="mx-1.5">·</span>
      <span>v0.1.0</span>
    </footer>
  )
}

// ── pieces ───────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <div className="mt-4 grid grid-cols-2 gap-2">
      <div className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
      <div className="h-16 animate-pulse rounded-xl bg-slate-100 dark:bg-slate-800" />
    </div>
  )
}

function LighthouseGlyph() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" aria-hidden="true">
      <title>Lighthouse</title>
      <path
        d="M8 1 L4 5 H6 V13 H10 V5 H12 Z"
        fill="currentColor"
        opacity="0.95"
      />
      <circle cx="8" cy="14.5" r="1.2" fill="currentColor" opacity="0.7" />
    </svg>
  )
}
function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" aria-hidden="true">
      <title>open</title>
      <path
        d="M9 6l6 6-6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function fmtRelative(epochMs: number): string {
  const diff = Date.now() - epochMs
  if (diff < 5_000) return '刚刚'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s 前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m 前`
  return `${Math.floor(diff / 3_600_000)}h 前`
}
