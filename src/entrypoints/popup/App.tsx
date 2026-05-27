import * as React from 'react'
import { WEB_ENDPOINT } from '@/lib/env'
import { sendMessage } from '@/lib/messaging'
import type { UserProfile } from '@/lib/storage'
import type { PairingState } from '@/types/messages'

/**
 * Toolbar popup — 320px 宽,展示插件运行状态 + KOL 身份概览。
 *
 * 视觉规范跟 Chrome Web Store screenshot-3-popup.png 1:1 一致:
 *   ① brand 顶栏     — burst icon + LIGHTHOUSE + Connected/Disconnected 绿/灰 chip
 *   ② identity row   — avatar + name + @handle + TIER chip
 *   ③ token row      — "Token" label + 脱敏 token + Manage
 *   ④ stats split    — 2 cell:Available LUX(余额 + today delta)/ Tasks live(数量 + sync 状态)
 *   ⑤ error banner   — sync 失败时浮上来,翻译错误成中文人话
 *   ⑥ footer         — "Background syncing" 状态 + "Open dashboard ↗"
 *
 * Popup 不做实际操作,只展示概览 + 跳到 options / lhdao.top。
 */

interface PopupData {
  hasToken: boolean
  tokenMasked: string | null
  profile: UserProfile | null
  taskCount: number
  tweetCount: number
  lastSyncAt: number | null
  lastSyncError: string | null
  lastSyncHttpStatus: number | null
}

export function App() {
  const [data, setData] = React.useState<PopupData | null>(null)
  const [syncing, setSyncing] = React.useState(false)
  const [pairing, setPairing] = React.useState<PairingState>({ kind: 'idle' })

  const readData = React.useCallback(async () => {
    const r = await sendMessage({ type: 'get-popup-data' })
    if (r.type === 'popup-data') {
      setData({
        hasToken: r.hasToken,
        tokenMasked: r.tokenMasked,
        profile: r.profile,
        taskCount: r.taskCount,
        tweetCount: r.tweetCount,
        lastSyncAt: r.lastSyncAt,
        lastSyncError: r.lastSyncError,
        lastSyncHttpStatus: r.lastSyncHttpStatus,
      })
    }
  }, [])

  // Pairing state — popup 重新打开时拉一次 + 监听 BG 广播
  React.useEffect(() => {
    void (async () => {
      const r = await sendMessage({ type: 'get-pairing-status' })
      if (r.type === 'pairing-status-result') setPairing(r.state)
    })()

    const listener = (msg: { type?: string; state?: PairingState }) => {
      if (msg?.type === 'pairing-status' && msg.state) {
        setPairing(msg.state)
        // Pairing 成功 → 立即刷一次 popup data 让 UI 转到 ConnectedBlock
        if (msg.state.kind === 'success') void readData()
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [readData])

  const forceSync = React.useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await sendMessage({ type: 'force-sync' })
    } finally {
      setSyncing(false)
      await readData()
    }
  }, [syncing, readData])

  React.useEffect(() => {
    void readData()
    const interval = setInterval(readData, 5000)
    return () => clearInterval(interval)
  }, [readData])

  const openOptions = () => chrome.runtime.openOptionsPage()
  const openWeb = () =>
    chrome.tabs.create({ url: `${WEB_ENDPOINT}/campaigns` })

  const startPair = React.useCallback(async () => {
    const r = await sendMessage({ type: 'start-pairing' })
    if (r.type === 'pairing-started' && !r.ok) {
      // BG 端 startup 失败(网络 / code 冲突),回 idle 让用户重试
      setPairing({ kind: 'error', reason: r.reason })
    }
  }, [])

  const cancelPair = React.useCallback(async () => {
    await sendMessage({ type: 'cancel-pairing' })
  }, [])

  return (
    <div className="bg-white text-slate-900 dark:bg-slate-950 dark:text-slate-100">
      <Header connected={!!data?.hasToken} hasData={!!data} />
      {data === null ? (
        <SkeletonBlock />
      ) : !data.hasToken ? (
        <SignInBlock
          pairing={pairing}
          onStart={startPair}
          onCancel={cancelPair}
          onOpenOptions={openOptions}
        />
      ) : (
        <ConnectedBlock
          data={data}
          syncing={syncing}
          onForceSync={forceSync}
          onOpenOptions={openOptions}
          onOpenWeb={openWeb}
        />
      )}
    </div>
  )
}

// ── ① Header ─────────────────────────────────────────────────────────

function Header({ connected, hasData }: { connected: boolean; hasData: boolean }) {
  return (
    <header className="flex items-center gap-2.5 border-b border-slate-200/70 px-4 pt-3.5 pb-3 dark:border-slate-800">
      <BrandPlate />
      <span className="text-[13px] font-black tracking-[0.02em] text-slate-900 dark:text-slate-50">
        LIGHTHOUSE
      </span>
      {hasData && (
        <span
          className={
            connected
              ? 'ml-auto inline-flex items-center gap-1.5 rounded-md bg-emerald-100 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.10em] text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300'
              : 'ml-auto inline-flex items-center gap-1.5 rounded-md bg-slate-200 px-2 py-0.5 text-[10px] font-bold uppercase tracking-[0.10em] text-slate-600 dark:bg-slate-800 dark:text-slate-400'
          }
        >
          <span
            className={
              connected
                ? 'h-1.5 w-1.5 rounded-full bg-emerald-600 shadow-[0_0_8px_rgba(5,150,105,0.5)]'
                : 'h-1.5 w-1.5 rounded-full bg-slate-400'
            }
          />
          {connected ? 'Connected' : 'No token'}
        </span>
      )}
    </header>
  )
}

/** Brand 标 — 跟主站 favicon.ico / chrome 工具栏 icon 完全一致。 */
function BrandPlate() {
  return <BurstIcon size={28} />
}

// ── ② Connected block (主内容) ───────────────────────────────────────

function ConnectedBlock({
  data,
  syncing,
  onForceSync,
  onOpenOptions,
  onOpenWeb,
}: {
  data: PopupData
  syncing: boolean
  onForceSync: () => void
  onOpenOptions: () => void
  onOpenWeb: () => void
}) {
  const hasError = !!data.lastSyncError

  return (
    <>
      <IdentityRow profile={data.profile} />
      <TokenRow
        masked={data.tokenMasked ?? '—'}
        onManage={onOpenOptions}
      />
      <StatsSplit
        balance={data.profile?.newLux ?? null}
        today={data.profile?.todayEarnings ?? null}
        taskCount={data.taskCount}
        lastSyncAt={data.lastSyncAt}
        syncing={syncing}
      />
      {hasError && (
        <SyncErrorBanner
          error={data.lastSyncError ?? ''}
          httpStatus={data.lastSyncHttpStatus}
          onOpenOptions={onOpenOptions}
        />
      )}
      <Footer
        syncing={syncing}
        hasError={hasError}
        onForceSync={onForceSync}
        onOpenWeb={onOpenWeb}
      />
    </>
  )
}

function IdentityRow({ profile }: { profile: UserProfile | null }) {
  const name = profile?.displayName ?? '灯塔账户'
  const handle = profile?.twitterHandle ?? null

  return (
    <div className="flex items-center gap-3 px-4 pt-3.5 pb-3">
      <Avatar src={profile?.avatar ?? null} name={name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[14px] font-bold leading-tight text-slate-900 dark:text-slate-50">
          {name}
        </div>
        {handle && (
          <div className="truncate text-[11.5px] text-slate-500 dark:text-slate-400">
            @{handle}
          </div>
        )}
      </div>
      {profile?.tier && (
        <span className="shrink-0 rounded-md bg-[#0F172A] px-2 py-1 text-[10px] font-bold uppercase tracking-[0.10em] text-[#5EEAD4]">
          TIER {profile.tier}
        </span>
      )}
    </div>
  )
}

function Avatar({ src, name }: { src: string | null; name: string }) {
  const [errored, setErrored] = React.useState(false)
  const initial = name?.[0]?.toUpperCase() ?? 'L'
  if (!src || errored) {
    return (
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-gradient-to-br from-emerald-400 to-cyan-500 text-[18px] font-black text-slate-900 shadow-[0_0_0_2px_#fff,0_0_0_4px_rgba(13,148,136,0.15)]">
        {initial}
      </span>
    )
  }
  return (
    <img
      src={src}
      alt={name}
      width={44}
      height={44}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => setErrored(true)}
      className="h-11 w-11 shrink-0 rounded-full object-cover shadow-[0_0_0_2px_#fff,0_0_0_4px_rgba(13,148,136,0.15)] dark:shadow-[0_0_0_2px_#0F172A,0_0_0_4px_rgba(94,234,212,0.20)]"
    />
  )
}

function TokenRow({
  masked,
  onManage,
}: {
  masked: string
  onManage: () => void
}) {
  return (
    <div className="mx-4 flex items-center gap-2.5 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 dark:border-slate-800 dark:bg-slate-900/50">
      <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
        Token
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-slate-900 dark:text-slate-100">
        {masked}
      </span>
      <button
        type="button"
        onClick={onManage}
        className="shrink-0 text-[11.5px] font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400"
      >
        Manage
      </button>
    </div>
  )
}

// ── ④ Stats split ────────────────────────────────────────────────────

function StatsSplit({
  balance,
  today,
  taskCount,
  lastSyncAt,
  syncing,
}: {
  balance: number | null
  today: number | null
  taskCount: number
  lastSyncAt: number | null
  syncing: boolean
}) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-px border-t border-slate-200 bg-slate-200 dark:border-slate-800 dark:bg-slate-800">
      <StatCell
        label="Available"
        value={formatBalance(balance)}
        unit="LUX"
        delta={
          today != null && today > 0
            ? { up: true, text: `+${formatToday(today)} today` }
            : null
        }
      />
      <StatCell
        label="Tasks live"
        value={String(taskCount)}
        unit="NOW"
        delta={
          syncing
            ? { text: 'syncing…', up: false }
            : lastSyncAt
              ? { text: `synced ${fmtRelative(lastSyncAt)}`, up: false }
              : null
        }
      />
    </div>
  )
}

function StatCell({
  label,
  value,
  unit,
  delta,
}: {
  label: string
  value: string
  unit: string
  delta: { text: string; up: boolean } | null
}) {
  return (
    <div className="bg-white px-3.5 py-3 dark:bg-slate-950">
      <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-[26px] font-black leading-none tracking-tight tabular-nums text-slate-900 dark:text-slate-50">
          {value}
        </span>
        <span className="text-[11px] font-bold tracking-[0.06em] text-teal-600 dark:text-teal-400">
          {unit}
        </span>
      </div>
      {delta && (
        <div
          className={
            delta.up
              ? 'mt-1.5 inline-flex items-center gap-1 text-[11px] text-teal-600 dark:text-teal-400'
              : 'mt-1.5 inline-flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400'
          }
        >
          {delta.up && (
            <svg width="10" height="10" viewBox="0 0 24 24" aria-hidden="true">
              <title>up</title>
              <polyline
                points="18 15 12 9 6 15"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
          {delta.text}
        </div>
      )}
    </div>
  )
}

// ── ⑥ Footer ─────────────────────────────────────────────────────────

function Footer({
  syncing,
  hasError,
  onForceSync,
  onOpenWeb,
}: {
  syncing: boolean
  hasError: boolean
  onForceSync: () => void
  onOpenWeb: () => void
}) {
  const dotColor = hasError
    ? 'bg-rose-500'
    : syncing
      ? 'bg-amber-500'
      : 'bg-teal-600 shadow-[0_0_8px_rgba(13,148,136,0.5)]'
  const statusText = hasError
    ? 'Sync failed'
    : syncing
      ? 'Syncing…'
      : 'Background syncing'

  return (
    <footer className="mt-0 flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3 text-[11.5px] dark:border-slate-800">
      <button
        type="button"
        onClick={onForceSync}
        disabled={syncing}
        className="inline-flex items-center gap-2 text-slate-500 hover:text-slate-700 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-200"
      >
        <span className={`h-1.5 w-1.5 rounded-full ${dotColor}`} />
        <span>{statusText}</span>
      </button>
      <button
        type="button"
        onClick={onOpenWeb}
        className="inline-flex items-center gap-1 font-semibold text-teal-600 hover:text-teal-700 dark:text-teal-400"
      >
        Open dashboard
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <title>open</title>
          <path d="M7 17L17 7M9 7h8v8" />
        </svg>
      </button>
    </footer>
  )
}

// ── Sign-in state — pairing-aware ────────────────────────────────────

function SignInBlock({
  pairing,
  onStart,
  onCancel,
  onOpenOptions,
}: {
  pairing: PairingState
  onStart: () => void
  onCancel: () => void
  onOpenOptions: () => void
}) {
  // Waiting:展示 spinner + 倒计时 + Cancel
  if (pairing.kind === 'waiting') {
    return (
      <div className="px-4 py-5 text-center">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-teal-50 dark:bg-teal-950/40">
          <Spinner />
        </div>
        <p className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
          等待主站授权…
        </p>
        <p className="mx-auto mt-1.5 max-w-[240px] text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
          已打开授权页。在那里点 <span className="font-semibold">Allow</span> 后,
          插件会自动接管。
        </p>
        <CountdownBar startedAt={pairing.startedAt} />
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-[11.5px] font-semibold text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
        >
          取消
        </button>
      </div>
    )
  }

  // Success:短暂展示成功态(BG 5s 后会自动 reset 到 idle)
  if (pairing.kind === 'success') {
    return (
      <div className="px-4 py-5 text-center">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <title>connected</title>
            <path d="M5 12l5 5L20 7" />
          </svg>
        </div>
        <p className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
          已连接
        </p>
        <p className="mx-auto mt-1.5 max-w-[240px] text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
          插件正在同步任务,稍后自动刷新。
        </p>
      </div>
    )
  }

  // Timeout / error / cancelled — 短暂提示 + 重试按钮
  if (pairing.kind === 'timeout' || pairing.kind === 'error' || pairing.kind === 'cancelled') {
    const reason =
      pairing.kind === 'timeout'
        ? '授权超时(60 秒未完成)'
        : pairing.kind === 'cancelled'
          ? '已取消'
          : pairing.reason
    return (
      <div className="px-4 py-5 text-center">
        <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-rose-50 text-rose-500 dark:bg-rose-950/40 dark:text-rose-400">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
            <title>error</title>
            <path d="M12 8v5" strokeLinecap="round" />
            <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
            <circle cx="12" cy="12" r="9" />
          </svg>
        </div>
        <p className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
          授权未完成
        </p>
        <p className="mx-auto mt-1.5 max-w-[260px] text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
          {reason}
        </p>
        <button
          type="button"
          onClick={onStart}
          className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-teal-600 to-cyan-500 px-3.5 py-1.5 text-[12px] font-bold text-white shadow-[0_4px_10px_-2px_rgba(13,148,136,0.35)] transition hover:brightness-105"
        >
          重试
        </button>
      </div>
    )
  }

  // Idle — 默认初始态
  return (
    <div className="px-4 py-5 text-center">
      <div className="mx-auto mb-3 flex justify-center">
        <BurstIcon size={44} />
      </div>
      <p className="text-[13px] font-bold text-slate-900 dark:text-slate-100">
        用 Lighthouse 账号登录
      </p>
      <p className="mx-auto mt-1.5 max-w-[240px] text-[11.5px] leading-relaxed text-slate-500 dark:text-slate-400">
        会在 lhdao 网站打开一个授权页,确认后插件自动连接。
      </p>
      <button
        type="button"
        onClick={onStart}
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-teal-600 to-cyan-500 px-4 py-2 text-[13px] font-bold text-white shadow-[0_1px_0_rgba(255,255,255,0.3)_inset,0_4px_10px_-2px_rgba(13,148,136,0.4)] transition hover:brightness-105"
      >
        立即登录
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <title>arrow</title>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      <button
        type="button"
        onClick={onOpenOptions}
        className="mt-3 block w-full text-[10.5px] text-slate-400 hover:text-slate-600 dark:text-slate-500 dark:hover:text-slate-300"
      >
        或在 Options 手动粘贴 token →
      </button>
    </div>
  )
}

function CountdownBar({ startedAt }: { startedAt: number }) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  const elapsedMs = now - startedAt
  const pct = Math.max(0, Math.min(100, (elapsedMs / 60_000) * 100))
  const remain = Math.max(0, Math.ceil((60_000 - elapsedMs) / 1000))
  return (
    <div className="mx-auto mt-3 max-w-[200px]">
      <div className="h-1 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
        <div
          className="h-full bg-gradient-to-r from-teal-500 to-cyan-400 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10px] tabular-nums text-slate-500 dark:text-slate-400">
        {remain}s
      </div>
    </div>
  )
}

function Spinner() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden className="animate-spin text-teal-600 dark:text-teal-400">
      <title>loading</title>
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeDasharray="40 18" strokeLinecap="round" />
    </svg>
  )
}

// ── Skeleton ─────────────────────────────────────────────────────────

function SkeletonBlock() {
  return (
    <div className="space-y-3 px-4 py-4">
      <div className="flex items-center gap-3">
        <div className="h-11 w-11 animate-pulse rounded-full bg-slate-200 dark:bg-slate-800" />
        <div className="flex-1 space-y-2">
          <div className="h-3 w-24 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
          <div className="h-2.5 w-16 animate-pulse rounded bg-slate-200 dark:bg-slate-800" />
        </div>
      </div>
      <div className="h-8 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-900" />
      <div className="grid grid-cols-2 gap-2">
        <div className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-900" />
        <div className="h-16 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-900" />
      </div>
    </div>
  )
}

// ── Sync error banner ───────────────────────────────────────────────

function SyncErrorBanner({
  error,
  httpStatus,
  onOpenOptions,
}: {
  error: string
  httpStatus: number | null
  onOpenOptions: () => void
}) {
  const { title, hint, action } = diagnoseSyncError(error, httpStatus)
  return (
    <div className="mx-4 mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 dark:border-rose-900/40 dark:bg-rose-950/30">
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 text-rose-500">⚠</span>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-bold text-rose-700 dark:text-rose-300">
            {title}
          </p>
          <p className="mt-0.5 text-[10.5px] leading-snug text-rose-600/90 dark:text-rose-300/80">
            {hint}
          </p>
          <details className="mt-1">
            <summary className="cursor-pointer text-[10px] text-rose-500/70 hover:text-rose-700 dark:text-rose-400/70 dark:hover:text-rose-300">
              查看原始错误
            </summary>
            <p className="mt-1 break-all rounded bg-white/60 p-1.5 font-mono text-[9.5px] text-rose-700 dark:bg-rose-950/40 dark:text-rose-200">
              {httpStatus ? `[HTTP ${httpStatus}] ` : ''}
              {error}
            </p>
          </details>
          {action === 'reconfigure' && (
            <button
              type="button"
              onClick={onOpenOptions}
              className="mt-1.5 text-[10.5px] font-bold text-rose-700 hover:underline dark:text-rose-300"
            >
              重新粘贴 token →
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Burst icon — 同 sidebar / brand 一致 ─────────────────────────────

/**
 * Brand mark — 矢量版本的 favicon.ico,跟主站 / chrome 工具栏 icon 100%
 * 一致(紫色 disc + 绿色 6 spokes + 白色 K-stem hook)。
 *
 * SVG 模板复用自 kol-dao-app/public/logo-icon-128-transparent.svg + 主站
 * BrandLogoFallback,viewBox 0 0 64 64,内嵌 disc bg 让任何尺寸独立显示。
 */
function BurstIcon({ size = 16 }: { size?: number }) {
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true">
      <title>Lighthouse</title>
      <circle cx="32" cy="32" r="32" fill="#2D24C4" />
      <g
        stroke="#2EE742"
        strokeWidth="6"
        strokeLinecap="round"
        transform="translate(32 32)"
      >
        <line x1="0" y1="0" x2="0" y2="-18" />
        <line x1="0" y1="0" x2="11" y2="-6" />
        <line x1="0" y1="0" x2="18" y2="5" />
        <line x1="0" y1="0" x2="-11" y2="-6" />
        <line x1="0" y1="0" x2="-18" y2="5" />
        <line x1="0" y1="0" x2="0" y2="13" />
      </g>
      <path
        d="M34 30 L34 46 M34 38 L44 30 M34 38 L44 46"
        stroke="#FFFFFF"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

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

function fmtRelative(epochMs: number): string {
  const diff = Date.now() - epochMs
  if (diff < 5_000) return 'just now'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  return `${Math.floor(diff / 3_600_000)}h ago`
}

// ── error → human ───────────────────────────────────────────────────

interface SyncDiagnosis {
  title: string
  hint: string
  action?: 'reconfigure'
}

function diagnoseSyncError(
  err: string,
  httpStatus: number | null,
): SyncDiagnosis {
  if (err === 'No API token configured') {
    return {
      title: '未配置 token',
      hint: '点 "去配置" 粘贴在 lhdao 网站创建的 plugin token',
      action: 'reconfigure',
    }
  }
  if (httpStatus === 401) {
    return {
      title: 'Token 无效',
      hint: 'token 已被吊销或者拼写不对。去 app.lhdao.top/settings/plugin-tokens 重建一个再粘贴。',
      action: 'reconfigure',
    }
  }
  if (/PLUGIN_TOKEN_SCOPE_DENIED/i.test(err)) {
    return {
      title: '后端 scope 守门拦截',
      hint: '后端启用了 plugin token 范围限制,但某个 resolver 还没贴 @AllowPluginToken()。等 Railway deploy 完或联系开发。',
    }
  }
  if (httpStatus === 403) {
    return {
      title: '权限被拒',
      hint: 'HTTP 403 — 后端拒绝了请求。详见下方原始错误。',
    }
  }
  if (httpStatus === 404) {
    return {
      title: 'GraphQL 端点找不到',
      hint: 'API_ENDPOINT 配置错了,或后端服务未启动。',
    }
  }
  if (httpStatus && httpStatus >= 500) {
    return {
      title: '后端错误',
      hint: `HTTP ${httpStatus} — 后端内部错误,稍后重试或联系开发。`,
    }
  }
  if (/Cannot query field/i.test(err)) {
    return {
      title: 'GraphQL schema 不匹配',
      hint: '部署的后端 schema 缺少 availableEngagements 字段,可能 Railway 没部署到最新 dev。',
    }
  }
  if (/jwt malformed|invalid signature|jwt expired/i.test(err)) {
    return {
      title: 'Token 格式不对',
      hint: '存的不是合法 plugin token(必须以 lhdao_pk_ 开头)。点 "去配置" 解绑后重新粘贴。',
      action: 'reconfigure',
    }
  }
  if (/Network error|Failed to fetch/i.test(err)) {
    return {
      title: '网络 / CORS 错误',
      hint: '可能后端没把 chrome-extension://* 加进 CORS 白名单,或本机连不上 service.lhdao.top。',
    }
  }
  return {
    title: '同步失败',
    hint: '展开下方查看完整错误。',
  }
}
