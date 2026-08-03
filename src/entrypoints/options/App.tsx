import * as React from 'react'
import { CAPTURE_DEBUG } from '@/lib/capture-debug'
import { WEB_ENDPOINT } from '@/lib/env'
import { GqlError, gql } from '@/lib/gql'
import { sendMessage } from '@/lib/messaging'
import { ME_QUERY, type MeResult } from '@/lib/queries'
import { localStore } from '@/lib/storage'
import type { PairingState } from '@/types/messages'

const TOKEN_PATTERN = /^lhdao_pk_[A-Za-z0-9_-]{32,}$/

type VerifyState =
  | { kind: 'idle' }
  | { kind: 'verifying' }
  | { kind: 'bound'; user: NonNullable<MeResult['me']> }
  | { kind: 'error'; message: string }

/**
 * Options page (chrome://extensions → Lighthouse → Options)。
 * 唯一职责:粘贴 plugin token → 校验 → 保存到 chrome.storage.local。
 *
 * 校验通过后会触发 chrome.storage.onChanged 监听器,background SW
 * 立刻 syncTasks(),用户切到 X 就能看到 chip。
 */
export function App() {
  const [token, setToken] = React.useState('')
  const [state, setState] = React.useState<VerifyState>({ kind: 'idle' })
  const [pairing, setPairing] = React.useState<PairingState>({ kind: 'idle' })

  // 启动时若已有 token,先回填 + 验证有效性
  React.useEffect(() => {
    void (async () => {
      const stored = await localStore.get('apiToken')
      if (!stored) return
      setToken(stored)
      setState({ kind: 'verifying' })
      try {
        const r = await gql<MeResult>(ME_QUERY)
        if (r.me) setState({ kind: 'bound', user: r.me })
        else setState({ kind: 'error', message: 'token 无效或用户不存在' })
      } catch (e) {
        setState({ kind: 'error', message: errorText(e) })
      }
    })()
  }, [])

  // 监听 BG pairing 状态广播 — 一键登录走的另一条路
  React.useEffect(() => {
    void (async () => {
      const r = await sendMessage({ type: 'get-pairing-status' })
      if (r.type === 'pairing-status-result') setPairing(r.state)
    })()
    const listener = (msg: { type?: string; state?: PairingState }) => {
      if (msg?.type === 'pairing-status' && msg.state) {
        setPairing(msg.state)
        // Pairing 成功后让 main verify 流程也跑一次,转到 Bound 卡
        if (msg.state.kind === 'success') {
          void (async () => {
            const stored = await localStore.get('apiToken')
            if (!stored) return
            setToken(stored)
            try {
              const r = await gql<MeResult>(ME_QUERY)
              if (r.me) setState({ kind: 'bound', user: r.me })
            } catch {
              /* 同步失败留给后续重试 */
            }
          })()
        }
      }
    }
    chrome.runtime.onMessage.addListener(listener)
    return () => chrome.runtime.onMessage.removeListener(listener)
  }, [])

  const startPair = React.useCallback(async () => {
    const r = await sendMessage({ type: 'start-pairing' })
    if (r.type === 'pairing-started' && !r.ok) {
      setPairing({ kind: 'error', reason: r.reason })
    }
  }, [])

  const cancelPair = React.useCallback(async () => {
    await sendMessage({ type: 'cancel-pairing' })
  }, [])

  const trimmed = token.trim()
  const valid = TOKEN_PATTERN.test(trimmed)
  const dirty = trimmed && state.kind !== 'verifying'

  const verify = async () => {
    if (!valid || state.kind === 'verifying') return
    setState({ kind: 'verifying' })

    // 关键:先 set token 给 gql() 用,验证失败立刻 remove 回滚 — 避免
    // 一个无效 token 留在 storage 让 popup 误认为已绑定。
    await localStore.set('apiToken', trimmed)
    try {
      const r = await gql<MeResult>(ME_QUERY)
      if (r.me) {
        setState({ kind: 'bound', user: r.me })
        return
      }
      await localStore.remove('apiToken')
      setState({ kind: 'error', message: 'token 无效或用户不存在' })
    } catch (e) {
      await localStore.remove('apiToken')
      setState({ kind: 'error', message: errorText(e) })
    }
  }

  const clearToken = async () => {
    await localStore.remove('apiToken')
    setToken('')
    setState({ kind: 'idle' })
  }

  return (
    <div className="mx-auto min-h-screen max-w-xl px-6 py-12">
      <header className="flex items-center gap-2">
        <BrandLogo size={36} className="rounded-xl shadow-md" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[20px] font-black tracking-tight text-slate-900 dark:text-slate-50">
            Lighthouse Extension
          </h1>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
            浏览器插件 · token 配置
          </p>
        </div>
      </header>

      {/* Bound state — show first, hide token UI when already bound */}
      {state.kind === 'bound' ? (
        <BoundCard user={state.user} onUnbind={clearToken} />
      ) : (
        <>
          <PrimaryPairCard
            pairing={pairing}
            onStart={startPair}
            onCancel={cancelPair}
          />

          {/* 折叠区 · 高级用户走手动粘贴 token(dev / staging / 调试) */}
          <details className="mt-6 rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900 [&>summary]:cursor-pointer [&[open]>summary]:border-b [&[open]>summary]:border-slate-200 dark:[&[open]>summary]:border-slate-800">
            <summary className="flex items-center justify-between px-5 py-3 text-[12.5px] font-bold text-slate-600 dark:text-slate-400 [&::-webkit-details-marker]:hidden">
              <span className="flex items-center gap-2">
                <ChevronIcon />
                高级 · 手动粘贴 token
              </span>
              <span className="text-[10.5px] font-medium text-slate-400 dark:text-slate-500">
                给开发者 / 调试用
              </span>
            </summary>
            <div className="px-5 pb-5">
              <Step1Instructions />
              <Step2TokenInput
                token={token}
                valid={valid}
                dirty={!!dirty}
                verifying={state.kind === 'verifying'}
                onChange={setToken}
                onVerify={verify}
              />
              {state.kind === 'error' && (
                <ErrorBanner
                  message={state.message}
                  onDismiss={() => setState({ kind: 'idle' })}
                />
              )}
            </div>
          </details>
        </>
      )}

      <SensitiveToggleCard />
      <BinanceProbePanel />

      <footer className="mt-12 border-t border-slate-200 pt-4 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-600">
        <p>
          token 仅存于 chrome.storage.local,不会出现在 localStorage 或 cookie。
        </p>
        <p className="mt-1">Lighthouse Extension · v0.1.0</p>
      </footer>
    </div>
  )
}

// ── Step 1 ───────────────────────────────────────────────────────────

function Step1Instructions() {
  return (
    <section className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 text-[13.5px] font-bold text-slate-900 dark:text-slate-100">
        <StepBadge n={1} />在 Lighthouse 网站创建 plugin token
      </h2>
      <p className="mt-2 text-[12px] leading-relaxed text-slate-600 dark:text-slate-400">
        点开下方链接,登录后点 <b>"创建 token"</b>,起个能让你认出的名字 (例如
        "Mac · Chrome")。
        <br />
        创建成功后,弹窗会显示 <b>明文 token(只显示一次)</b>,立即点击复制。
      </p>
      <a
        href={`${WEB_ENDPOINT}/settings/plugin-tokens`}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-slate-900 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white"
      >
        打开 lhdao 设置页
        <ExternalIcon />
      </a>
      <p className="mt-2 text-[10.5px] text-slate-400 dark:text-slate-600">
        当前环境:
        <code className="ml-1 rounded bg-slate-100 px-1 py-px font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          {hostFrom(WEB_ENDPOINT)}
        </code>
      </p>
    </section>
  )
}

// ── Step 2 ───────────────────────────────────────────────────────────

function Step2TokenInput({
  token,
  valid,
  dirty,
  verifying,
  onChange,
  onVerify,
}: {
  token: string
  valid: boolean
  dirty: boolean
  verifying: boolean
  onChange: (v: string) => void
  onVerify: () => void
}) {
  return (
    <section className="mt-3 rounded-2xl border border-slate-200 bg-white p-5 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="flex items-center gap-2 text-[13.5px] font-bold text-slate-900 dark:text-slate-100">
        <StepBadge n={2} />
        粘贴 token
      </h2>
      <textarea
        value={token}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        placeholder="lhdao_pk_..."
        className="mt-3 block w-full resize-none rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 font-mono text-[12px] leading-snug text-slate-800 outline-none ring-teal-500/20 focus:border-teal-400 focus:ring-2 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-100"
      />
      <div className="mt-2 flex items-center justify-between gap-2">
        <p className="text-[11px] text-slate-400 dark:text-slate-600">
          {token && !valid
            ? '格式不对 — 必须以 lhdao_pk_ 开头'
            : 'token 不会发送到任何第三方服务器'}
        </p>
        <button
          type="button"
          onClick={onVerify}
          disabled={!valid || verifying}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-r from-teal-500 to-cyan-500 px-3 text-[12px] font-bold text-white shadow-sm transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {verifying ? (
            <>
              <SpinnerIcon className="h-3 w-3 animate-spin" />
              验证中
            </>
          ) : dirty ? (
            <>
              <CheckIcon className="h-3 w-3" />
              保存并验证
            </>
          ) : (
            '保存并验证'
          )}
        </button>
      </div>
    </section>
  )
}

// ── Bound card ───────────────────────────────────────────────────────

function BoundCard({
  user,
  onUnbind,
}: {
  user: NonNullable<MeResult['me']>
  onUnbind: () => void
}) {
  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-emerald-200 bg-white shadow-sm dark:border-emerald-900/40 dark:bg-slate-900">
      <div className="flex items-center gap-3 bg-emerald-50 px-5 py-4 dark:bg-emerald-950/30">
        <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-white">
          <CheckIcon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <p className="text-[13.5px] font-bold text-emerald-700 dark:text-emerald-300">
            已绑定 @{user.username}
          </p>
          <p className="mt-0.5 text-[11.5px] text-emerald-600/80 dark:text-emerald-400/70">
            插件可正常拉取任务并提交
          </p>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-4 px-5 py-4 text-[12px]">
        <div>
          <dt className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
            Username
          </dt>
          <dd className="mt-1 font-medium text-slate-900 dark:text-slate-100">
            @{user.username}
          </dd>
        </div>
        <div>
          <dt className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
            Tier
          </dt>
          <dd className="mt-1 font-medium text-slate-900 dark:text-slate-100">
            {user.tier ?? '—'}
          </dd>
        </div>
        {user.nickname && (
          <div className="col-span-2">
            <dt className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400">
              Nickname
            </dt>
            <dd className="mt-1 font-medium text-slate-900 dark:text-slate-100">
              {user.nickname}
            </dd>
          </div>
        )}
      </dl>
      <div className="border-t border-slate-200 px-5 py-3 text-right dark:border-slate-800">
        <button
          type="button"
          onClick={onUnbind}
          className="rounded-lg border border-rose-200 px-3 py-1.5 text-[11.5px] font-bold text-rose-600 transition hover:bg-rose-50 dark:border-rose-900/40 dark:text-rose-400 dark:hover:bg-rose-950/30"
        >
          解除绑定
        </button>
      </div>
    </section>
  )
}

// ── pieces ───────────────────────────────────────────────────────────

function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}) {
  return (
    <div className="mt-3 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-[12px] text-rose-700 dark:border-rose-900/40 dark:bg-rose-950/30 dark:text-rose-300">
      <span className="mt-px shrink-0">⚠️</span>
      <p className="min-w-0 flex-1 break-all">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded p-0.5 text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/30"
        aria-label="dismiss"
      >
        ×
      </button>
    </div>
  )
}

function StepBadge({ n }: { n: number }) {
  return (
    <span className="flex h-5 w-5 items-center justify-center rounded-full bg-teal-100 text-[10px] font-black text-teal-700 dark:bg-teal-950/40 dark:text-teal-400">
      {n}
    </span>
  )
}

/**
 * Brand 标识 — 跟 popup/App.tsx 同样的"PNG 优先 + inline SVG fallback"
 * 策略。任何地方需要 logo 都用 <BrandLogo size={N} /> — 跟 store icon
 * 100% 一致(因为本质就是 icon/128.png)。
 */
function BrandLogo({
  size = 36,
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
function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>OK</title>
      <path
        d="M5 13l4 4L19 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
function SpinnerIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true">
      <title>Loading</title>
      <circle
        cx="12"
        cy="12"
        r="9"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray="40 18"
        strokeLinecap="round"
      />
    </svg>
  )
}
function ExternalIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" aria-hidden="true">
      <title>External</title>
      <path
        d="M14 4h6v6M20 4l-8 8M9 6H4v14h14v-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3 w-3" aria-hidden="true">
      <title>expand</title>
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

/**
 * Brand mark — 直接用 manifest 里 icon/128.png(favicon 派生)。
 * 跟主站 favicon / chrome 工具栏图标像素级一致,不做 SVG 复刻避免偏差。
 */
function BurstIcon({ size = 22 }: { size?: number }) {
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
      style={{ display: 'inline-block' }}
    />
  )
}

// ── PrimaryPairCard — 一键登录 hero(代替原 Step 1+2 作为默认入口) ──

function PrimaryPairCard({
  pairing,
  onStart,
  onCancel,
}: {
  pairing: PairingState
  onStart: () => void
  onCancel: () => void
}) {
  // Waiting
  if (pairing.kind === 'waiting') {
    return (
      <section className="mt-8 overflow-hidden rounded-2xl border border-teal-200 bg-gradient-to-br from-teal-50 to-cyan-50 p-6 dark:border-teal-900/40 dark:from-teal-950/30 dark:to-cyan-950/20">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-white shadow-sm dark:bg-slate-900">
            <SpinnerIcon className="h-5 w-5 animate-spin text-teal-600 dark:text-teal-400" />
          </span>
          <div>
            <p className="text-[14px] font-bold text-slate-900 dark:text-slate-100">
              等待主站授权…
            </p>
            <p className="mt-0.5 text-[12px] text-slate-600 dark:text-slate-400">
              已打开授权页。完成后插件自动接管。
            </p>
          </div>
        </div>
        <PairingCountdownBar startedAt={pairing.startedAt} />
        <button
          type="button"
          onClick={onCancel}
          className="mt-3 text-[12px] font-semibold text-slate-500 underline-offset-2 hover:text-slate-700 hover:underline dark:text-slate-400 dark:hover:text-slate-200"
        >
          取消
        </button>
      </section>
    )
  }

  // Success — 短暂提示,父组件会切到 BoundCard
  if (pairing.kind === 'success') {
    return (
      <section className="mt-8 rounded-2xl border border-emerald-200 bg-emerald-50 p-6 dark:border-emerald-900/40 dark:bg-emerald-950/30">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-emerald-500 text-white">
            <CheckIcon className="h-5 w-5" />
          </span>
          <div>
            <p className="text-[14px] font-bold text-emerald-700 dark:text-emerald-300">
              已连接 Lighthouse
            </p>
            <p className="mt-0.5 text-[12px] text-emerald-600/80 dark:text-emerald-400/70">
              正在同步任务…
            </p>
          </div>
        </div>
      </section>
    )
  }

  // Timeout / error / cancelled — 显示原因 + 重试按钮
  if (
    pairing.kind === 'timeout' ||
    pairing.kind === 'error' ||
    pairing.kind === 'cancelled'
  ) {
    const reason =
      pairing.kind === 'timeout'
        ? '授权超时(60 秒未完成)'
        : pairing.kind === 'cancelled'
          ? '已取消授权'
          : pairing.reason
    return (
      <section className="mt-8 rounded-2xl border border-rose-200 bg-rose-50 p-6 dark:border-rose-900/40 dark:bg-rose-950/30">
        <div className="flex items-center gap-3">
          <span className="grid h-10 w-10 place-items-center rounded-full bg-rose-100 text-rose-600 dark:bg-rose-950/60 dark:text-rose-400">
            <svg
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden
            >
              <title>error</title>
              <path d="M12 8v5" strokeLinecap="round" />
              <circle cx="12" cy="16.5" r="0.6" fill="currentColor" />
              <circle cx="12" cy="12" r="9" />
            </svg>
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-bold text-rose-700 dark:text-rose-300">
              授权未完成
            </p>
            <p className="mt-0.5 break-all text-[12px] text-rose-600/80 dark:text-rose-400/70">
              {reason}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={onStart}
          className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-gradient-to-br from-teal-600 to-cyan-500 px-4 py-2 text-[13px] font-bold text-white shadow-[0_4px_10px_-2px_rgba(13,148,136,0.35)] transition hover:brightness-105"
        >
          重新发起授权
        </button>
      </section>
    )
  }

  // Idle — 默认 hero
  return (
    <section className="mt-8 overflow-hidden rounded-2xl border border-slate-200 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-center gap-3">
        <BurstIcon size={48} />
        <div>
          <h2 className="text-[15px] font-black tracking-tight text-slate-900 dark:text-slate-50">
            用 Lighthouse 账号登录
          </h2>
          <p className="mt-0.5 text-[12px] text-slate-500 dark:text-slate-400">
            点击下方按钮,会跳转到主站确认授权。不需要手动粘贴 token。
          </p>
        </div>
      </div>
      <button
        type="button"
        onClick={onStart}
        className="mt-5 inline-flex items-center gap-2 rounded-lg bg-gradient-to-br from-teal-600 to-cyan-500 px-5 py-2.5 text-[13.5px] font-bold text-white shadow-[0_1px_0_rgba(255,255,255,0.3)_inset,0_4px_10px_-2px_rgba(13,148,136,0.4)] transition hover:brightness-105"
      >
        立即登录
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <title>arrow</title>
          <path d="M5 12h14M13 6l6 6-6 6" />
        </svg>
      </button>
      <p className="mt-3 text-[10.5px] text-slate-400 dark:text-slate-600">
        授权过程会创建一个跟当前账号绑定的 plugin token,可随时在主站
        <code className="mx-1 rounded bg-slate-100 px-1 py-px font-mono text-slate-600 dark:bg-slate-800 dark:text-slate-400">
          /settings/plugin-tokens
        </code>
        撤销。
      </p>
    </section>
  )
}

function PairingCountdownBar({ startedAt }: { startedAt: number }) {
  const [now, setNow] = React.useState(Date.now())
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(id)
  }, [])
  const elapsedMs = now - startedAt
  const pct = Math.max(0, Math.min(100, (elapsedMs / 60_000) * 100))
  const remain = Math.max(0, Math.ceil((60_000 - elapsedMs) / 1000))
  return (
    <div className="mt-4">
      <div className="h-1 overflow-hidden rounded-full bg-white/60 dark:bg-slate-800">
        <div
          className="h-full bg-gradient-to-r from-teal-500 to-cyan-400 transition-[width]"
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="mt-1 text-[10.5px] tabular-nums text-slate-500 dark:text-slate-400">
        剩余 {remain}s
      </div>
    </div>
  )
}

// ── helpers ──────────────────────────────────────────────────────────

function errorText(e: unknown): string {
  if (e instanceof GqlError) {
    if (e.httpStatus === 401) return 'token 无效或已被吊销'
    return e.message
  }
  return e instanceof Error ? e.message : String(e)
}

/** 从 https://app.lhdao.top 抽出 app.lhdao.top 给 UI 显示 */
function hostFrom(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

// ── Feature B · Sensitive content toggle ────────────────────────────

/**
 * "屏蔽 sensitive 推文" 开关。
 *
 * 直接读写 chrome.storage.local.hideSensitiveTweets,content script 监听
 * onChanged 实时 apply / un-apply,不需要刷页。
 *
 * 默认 true(初次安装即生效)— 首次 mount 时如果 storage 里没值,显示成
 * "已开",用户翻开关时才把 false 写进去。
 */
function SensitiveToggleCard() {
  const [on, setOn] = React.useState<boolean | null>(null) // null = 还在加载
  const [busy, setBusy] = React.useState(false)

  React.useEffect(() => {
    void (async () => {
      try {
        const v = await localStore.get('hideSensitiveTweets')
        setOn(v !== false) // null/undefined → 默认 true
      } catch {
        setOn(true)
      }
    })()
  }, [])

  const toggle = React.useCallback(async () => {
    if (on === null || busy) return
    setBusy(true)
    const next = !on
    try {
      await localStore.set('hideSensitiveTweets', next)
      setOn(next)
    } finally {
      setBusy(false)
    }
  }, [on, busy])

  return (
    <section className="mt-6 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <div className="flex items-start gap-4 p-5">
        <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-slate-100 dark:bg-slate-800">
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="text-slate-500 dark:text-slate-400"
            aria-hidden="true"
          >
            <title>shield</title>
            <path
              d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"
              strokeLinejoin="round"
            />
            <path
              d="M9 12l2 2 4-4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="text-[14px] font-bold text-slate-900 dark:text-slate-100">
            屏蔽敏感推文
          </h2>
          <p className="mt-1 text-[12px] leading-relaxed text-slate-500 dark:text-slate-400">
            自动隐藏 X 上被标记为成人 / 软色情 / 暴力等
            <span className="font-semibold text-slate-600 dark:text-slate-300">
              {' '}
              sensitive 内容{' '}
            </span>
            的推文。仅依赖 X 自己的判断,不读你的浏览记录。
          </p>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={!!on}
          onClick={toggle}
          disabled={on === null || busy}
          className={
            on
              ? 'relative h-7 w-12 shrink-0 rounded-full bg-gradient-to-br from-teal-600 to-cyan-500 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)] transition disabled:opacity-50'
              : 'relative h-7 w-12 shrink-0 rounded-full bg-slate-300 transition disabled:opacity-50 dark:bg-slate-700'
          }
        >
          <span
            className={
              on
                ? 'absolute left-[22px] top-[3px] block h-5 w-5 rounded-full bg-white shadow transition'
                : 'absolute left-[3px] top-[3px] block h-5 w-5 rounded-full bg-white shadow transition'
            }
          />
        </button>
      </div>
    </section>
  )
}

export function BinanceProbePanel() {
  const [count, setCount] = React.useState(0)
  const [copied, setCopied] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState<string | null>(null)
  const generation = React.useRef(0)
  const mounted = React.useRef(false)

  React.useEffect(() => {
    mounted.current = true
    const current = ++generation.current
    if (!CAPTURE_DEBUG) {
      return () => {
        mounted.current = false
        generation.current += 1
      }
    }
    void sendMessage({ type: 'export-binance-probe-observations' })
      .then((response) => {
        if (
          mounted.current &&
          current === generation.current &&
          response.type === 'binance-probe-observations'
        ) {
          setCount(response.observations.length)
        }
      })
      .catch(() => {
        if (mounted.current && current === generation.current) {
          setStatus('加载失败')
        }
      })
    return () => {
      mounted.current = false
      generation.current += 1
    }
  }, [])

  if (!CAPTURE_DEBUG) return null

  const copy = async () => {
    const current = ++generation.current
    setBusy(true)
    setCopied(false)
    setStatus(null)
    try {
      const response = await sendMessage({
        type: 'export-binance-probe-observations',
      })
      if (!mounted.current || current !== generation.current) return
      if (response.type !== 'binance-probe-observations') {
        setStatus('复制失败')
        return
      }
      await navigator.clipboard.writeText(
        JSON.stringify(response.observations, null, 2),
      )
      if (!mounted.current || current !== generation.current) return
      setCount(response.observations.length)
      setCopied(true)
    } catch {
      if (mounted.current && current === generation.current) {
        setStatus('复制失败')
      }
    } finally {
      if (mounted.current && current === generation.current) {
        setBusy(false)
      }
    }
  }

  const clear = async () => {
    const current = ++generation.current
    setBusy(true)
    setStatus(null)
    try {
      const response = await sendMessage({
        type: 'clear-binance-probe-observations',
      })
      if (!mounted.current || current !== generation.current) return
      if (response.type !== 'ack') {
        setStatus('清空失败')
        return
      }
      setCount(0)
      setCopied(false)
    } catch {
      if (mounted.current && current === generation.current) {
        setStatus('清空失败')
      }
    } finally {
      if (mounted.current && current === generation.current) {
        setBusy(false)
      }
    }
  }

  return (
    <section className="mt-6 rounded-2xl border border-amber-300 bg-amber-50 p-5 dark:border-amber-900/60 dark:bg-amber-950/30">
      <h2 className="text-[14px] font-bold text-amber-950 dark:text-amber-100">
        Binance Square Beta Probe
      </h2>
      <p className="mt-1 text-[12px] leading-relaxed text-amber-800 dark:text-amber-300">
        已采集 {count} 条脱敏 fixture。数据仅保留在当前浏览器 session
        24h，不会自动上传。
      </p>
      {status && (
        <p
          aria-live="polite"
          className="mt-2 text-[12px] font-semibold text-rose-700 dark:text-rose-300"
        >
          {status}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={copy}
          disabled={busy}
          className="rounded-lg bg-amber-600 px-3 py-1.5 text-[12px] font-bold text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {copied ? '已复制' : '复制脱敏 fixtures'}
        </button>
        <button
          type="button"
          onClick={clear}
          disabled={busy}
          className="rounded-lg border border-amber-300 px-3 py-1.5 text-[12px] font-bold text-amber-800 hover:bg-amber-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-amber-800 dark:text-amber-300 dark:hover:bg-amber-950/50"
        >
          清空
        </button>
      </div>
    </section>
  )
}
