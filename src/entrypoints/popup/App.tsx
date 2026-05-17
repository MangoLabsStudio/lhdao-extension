import * as React from 'react'
import { WEB_ENDPOINT } from '@/lib/env'
import { sendMessage } from '@/lib/messaging'
import { type CampaignTaskCache, sessionStore } from '@/lib/storage'

interface PopupSummary {
  hasToken: boolean
  taskCount: number
  tweetCount: number
  lastSyncAt: number | null
  lastSyncError: string | null
  lastSyncHttpStatus: number | null
}

/**
 * Toolbar popup — 320px 宽小窗,展示插件运行状态。
 * 不做实际操作,只显示概览 + 跳到 options 页 / lhdao 网站。
 */
export function App() {
  const [s, setS] = React.useState<PopupSummary | null>(null)
  const [syncing, setSyncing] = React.useState(false)

  // 只读模式刷新:不触发 sync,只重读 storage 的当前快照
  const readSummary = React.useCallback(async () => {
    const tokenStatus = await sendMessage({ type: 'has-token' })
    const map = (await sessionStore.get('tasksByTweetId')) ?? {}
    const lastSync = await sessionStore.get('lastSyncAt')
    const lastSyncError = await sessionStore.get('lastSyncError')
    const lastSyncHttpStatus = await sessionStore.get('lastSyncHttpStatus')
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
      lastSyncError: lastSyncError ?? null,
      lastSyncHttpStatus: lastSyncHttpStatus ?? null,
    })
  }, [])

  // "刷新" 按钮:触发 BG 立即 sync,等结果后再读
  const forceSync = React.useCallback(async () => {
    if (syncing) return
    setSyncing(true)
    try {
      await sendMessage({ type: 'force-sync' })
    } finally {
      setSyncing(false)
      await readSummary()
    }
  }, [syncing, readSummary])

  React.useEffect(() => {
    void readSummary()
    const interval = setInterval(readSummary, 5000)
    return () => clearInterval(interval)
  }, [readSummary])

  const openOptions = () => {
    chrome.runtime.openOptionsPage()
  }
  const openWeb = () => {
    chrome.tabs.create({ url: `${WEB_ENDPOINT}/campaigns` })
  }

  return (
    <div className="px-4 pt-4 pb-3">
      <Header />
      {s === null ? (
        <SkeletonRow />
      ) : !s.hasToken ? (
        <NoTokenBlock onOpenOptions={openOptions} />
      ) : (
        <ActiveBlock
          summary={s}
          syncing={syncing}
          onOpenWeb={openWeb}
          onForceSync={forceSync}
          onOpenOptions={openOptions}
        />
      )}
      <Footer onOpenOptions={openOptions} />
    </div>
  )
}

// ── Header ───────────────────────────────────────────────────────────

function Header() {
  return (
    <header className="flex items-center gap-2">
      <BrandLogo size={28} className="rounded-lg shadow-sm" />

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
  syncing,
  onOpenWeb,
  onForceSync,
  onOpenOptions,
}: {
  summary: PopupSummary
  syncing: boolean
  onOpenWeb: () => void
  onForceSync: () => void
  onOpenOptions: () => void
}) {
  const hasError = !!summary.lastSyncError
  const dotColor = hasError ? 'bg-rose-500' : 'bg-emerald-500'

  return (
    <>
      {/* KPI grid */}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <KpiCard label="活跃任务" value={summary.taskCount} accent />
        <KpiCard label="覆盖推文" value={summary.tweetCount} />
      </div>

      {/* Sync status */}
      <div className="mt-3 flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-[10.5px] dark:border-slate-800 dark:bg-slate-900">
        <span className="flex min-w-0 items-center gap-1.5 text-slate-500 dark:text-slate-400">
          <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotColor}`} />
          <span className="truncate">
            {syncing
              ? '同步中…'
              : summary.lastSyncAt
                ? `上次同步 ${fmtRelative(summary.lastSyncAt)}`
                : hasError
                  ? '同步失败'
                  : '尚未同步'}
          </span>
        </span>
        <button
          type="button"
          onClick={onForceSync}
          disabled={syncing}
          className="shrink-0 text-teal-600 hover:underline disabled:opacity-50 dark:text-teal-400"
        >
          {syncing ? '...' : '刷新'}
        </button>
      </div>

      {/* Sync error banner — surface real reason here so user doesn't need DevTools */}
      {hasError && (
        <SyncErrorBanner
          error={summary.lastSyncError ?? ''}
          httpStatus={summary.lastSyncHttpStatus}
          onOpenOptions={onOpenOptions}
        />
      )}

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
    <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-2.5 dark:border-rose-900/40 dark:bg-rose-950/30">
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
  const isBeta = WEB_ENDPOINT.includes('lhdaobeta')
  return (
    <footer className="mt-4 flex items-center justify-between gap-2 border-t border-slate-200 pt-2 text-[10px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
      <span>
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
      </span>
      {isBeta && (
        <span
          className="rounded bg-amber-100 px-1.5 py-px font-bold text-amber-700 dark:bg-amber-950/40 dark:text-amber-300"
          title={`build targets ${WEB_ENDPOINT}`}
        >
          BETA
        </span>
      )}
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

/**
 * Brand 标识 — 优先用 chrome.runtime.getURL('icon/128.png')(跟 store icon
 * 100% 一致),网络/资源加载失败 fallback 到 inline SVG 复刻(紫底圆 + 绿色
 * 放射 spoke + 白色弯钩,跟 ICO 源同款设计)。
 *
 * 任何尺寸调用 <BrandLogo size={28} /> 都按 size 渲染 — PNG 走 width/height,
 * SVG viewBox 64 内部按比例自适应。
 */
function BrandLogo({
  size = 28,
  className,
}: {
  size?: number
  className?: string
}) {
  const [src, setSrc] = React.useState<string | null>(() => {
    try {
      return chrome.runtime.getURL('icon/128.png')
    } catch {
      return null
    }
  })
  const style = { width: size, height: size }
  if (!src) return <BrandLogoFallback style={style} className={className} />
  return (
    <img
      src={src}
      alt="Lighthouse"
      width={size}
      height={size}
      className={className}
      onError={() => setSrc(null)}
    />
  )
}

function BrandLogoFallback({
  style,
  className,
}: {
  style?: React.CSSProperties
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 64 64"
      style={style}
      className={className}
      aria-hidden="true"
    >
      <title>Lighthouse</title>
      {/* indigo disc background */}
      <circle cx="32" cy="32" r="32" fill="#2D24C4" />
      {/* 6-spoke radial in bright green */}
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
      {/* white hook in lower-right (simplified K-stem) */}
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

interface SyncDiagnosis {
  title: string
  hint: string
  action?: 'reconfigure'
}

/**
 * 把 sync 失败的 error message + httpStatus 翻译成中文人话 + 修复建议。
 * 顺序很重要 — 先 match 具体 code,再 fallback 通用文案。
 */
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
      hint: 'token 已被吊销 / 在错的环境创建。BETA 构建必须配 lhdaobeta.top 上创建的 token,反之亦然。',
      action: 'reconfigure',
    }
  }
  if (/PLUGIN_TOKEN_SCOPE_DENIED/i.test(err)) {
    return {
      title: '后端 scope 守门拦截',
      hint: '后端启用了 plugin token 范围限制,但 availableEngagements 还没贴 @AllowPluginToken()。Railway 上 backend 部署可能不完整,等 deploy 完或重新触发。',
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
  // jwt malformed = 存的 token 不以 lhdao_pk_ 开头,被后端当 JWT 解析失败。
  // 大概率是早期版本残留 token / 粘贴时缺前缀 / 误粘了 cookie 里的 JWT。
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
      hint: '可能后端没把 chrome-extension://* 加进 CORS 白名单,或本机连不上 lhdaobeta.top。',
    }
  }
  return {
    title: '同步失败',
    hint: '展开下方查看完整错误。',
  }
}
