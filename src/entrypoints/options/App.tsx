import * as React from 'react'
import { WEB_ENDPOINT } from '@/lib/env'
import { GqlError, gql } from '@/lib/gql'
import { ME_QUERY, type MeResult } from '@/lib/queries'
import { localStore } from '@/lib/storage'

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
        </>
      )}

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
