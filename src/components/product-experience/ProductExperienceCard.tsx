import type { ProductExperienceControllerState } from '@/lib/product-experience-controller'
import type {
  ProductZkTlsRuleProgress,
  ProductZkTlsScalar,
} from '@/types/product-experience'

interface ProductExperienceCardProps {
  state: ProductExperienceControllerState
  busy?: boolean
  onStart(): void
}

const STATUS_COPY: Record<
  ProductExperienceControllerState['status'],
  { label: string; detail: string; tone: string }
> = {
  idle: {
    label: '等待任务',
    detail: '从 Lighthouse 任务页选择一个产品体验任务。',
    tone: 'bg-slate-500',
  },
  ready: {
    label: '准备验证',
    detail: '打开任务指定的客户网站，再主动开始。',
    tone: 'bg-cyan-300',
  },
  authorizing: {
    label: '正在授权',
    detail: '正在为当前标签页建立本次临时验证。',
    tone: 'bg-amber-300',
  },
  observing: {
    label: '正在检查',
    detail: '保持当前页面打开，完成 Buyer 声明的步骤。',
    tone: 'bg-teal-300',
  },
  submitting: {
    label: '正在提交',
    detail: '完成标记已命中，正在安全提交脱敏证据。',
    tone: 'bg-sky-300',
  },
  verified: {
    label: '验证通过',
    detail: '产品体验已确认，可回 Lighthouse 继续任务。',
    tone: 'bg-emerald-300',
  },
  expired: {
    label: '验证已过期',
    detail: '请回 Lighthouse 任务页重新发起验证。',
    tone: 'bg-orange-300',
  },
  'origin-mismatch': {
    label: '当前网站不匹配',
    detail: '请先打开任务允许的客户网站。',
    tone: 'bg-rose-300',
  },
  reauthorize: {
    label: '需要授权',
    detail: '页面或网站已变更；重新授权后，已完成进度会保留。',
    tone: 'bg-amber-300',
  },
  error: {
    label: '验证遇到问题',
    detail: '请回 Lighthouse 任务页检查状态后重试。',
    tone: 'bg-rose-300',
  },
}

function actionLabel(state: ProductExperienceControllerState): string | null {
  const { status } = state
  if (state.error === 'ORIGIN_NOT_ALLOWED' || status === 'origin-mismatch') {
    return '检查当前网站'
  }
  if (status === 'reauthorize') return '重新授权'
  if (isRetryableProofState(state)) return '重试证明'
  if (isContinuableIncompleteProofState(state)) return '继续证明'
  if (status === 'ready') return '开始验证'
  return null
}

function isRetryableProofState(
  state: ProductExperienceControllerState,
): boolean {
  return (
    state.status === 'observing' &&
    state.zkTlsProgress !== undefined &&
    (state.error === 'VERIFICATION_FAILED' || state.error === 'SESSION_EXPIRED')
  )
}

function isContinuableIncompleteProofState(
  state: ProductExperienceControllerState,
): boolean {
  return (
    state.status === 'observing' &&
    state.error === null &&
    state.currentOriginAllowed &&
    state.zkTlsProgress?.some(
      (entry) => entry.status === 'PARTIAL' || entry.status === 'PENDING',
    ) === true
  )
}

function projectCopy(
  state: ProductExperienceControllerState,
  busy: boolean,
): { label: string; detail: string; tone: string } {
  if (busy) return STATUS_COPY.authorizing
  if (state.status === 'verified') return STATUS_COPY.verified
  if (
    state.error === 'ORIGIN_NOT_ALLOWED' ||
    state.status === 'origin-mismatch'
  ) {
    return STATUS_COPY['origin-mismatch']
  }
  if (state.status === 'reauthorize') return STATUS_COPY.reauthorize
  if (isRetryableProofState(state)) {
    return {
      label: '证明失败',
      detail: '本次证明未完成，可安全重试。',
      tone: 'bg-rose-300',
    }
  }

  const progress = state.zkTlsProgress
  if (progress) {
    if (progress.some((entry) => entry.status === 'SUBMITTED')) {
      return {
        label: '证明已提交',
        detail: '证明已提交，等待后端确认。',
        tone: 'bg-sky-300',
      }
    }
    if (state.status === 'submitting') {
      return {
        label: '正在生成证明',
        detail: '请保持当前页面打开。',
        tone: 'bg-cyan-300',
      }
    }
    if (progress.some((entry) => entry.status === 'PARTIAL')) {
      return {
        label: '部分完成',
        detail: '累计进度以后端已确认的证明为准。',
        tone: 'bg-teal-300',
      }
    }
    return {
      label: '等待证明',
      detail: '达到页面条件后，插件会自动发起证明。',
      tone: 'bg-slate-500',
    }
  }

  return STATUS_COPY[state.status]
}

function displayText(value: string): string {
  let result = ''
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    const unsafe =
      code <= 31 ||
      (code >= 127 && code <= 159) ||
      code === 0x061c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    result += unsafe ? ' ' : value[index]
  }
  return result
}

function scalarLabel(value: ProductZkTlsScalar): string {
  if (value === true) return '是'
  if (value === false) return '否'
  return value === null ? '' : displayText(String(value))
}

function progressValue(progress: ProductZkTlsRuleProgress): string | null {
  if (progress.current === null || progress.target === null) return null
  const unit = progress.unit ? ` ${displayText(progress.unit)}` : ''
  return `${scalarLabel(progress.current)} / ${scalarLabel(progress.target)}${unit}`
}

function progressLabel(progress: ProductZkTlsRuleProgress): string {
  if (progress.status === 'PENDING') return '等待证明'
  if (progress.status === 'SUBMITTED') return '已提交，等待后端确认'
  const value = progressValue(progress)
  const detail = value ? `（${value}）` : ''
  return progress.status === 'VERIFIED'
    ? `已完成${detail}`
    : `部分完成${detail}`
}

export function ProductExperienceCard({
  state,
  busy = false,
  onStart,
}: ProductExperienceCardProps) {
  const copy = projectCopy(state, busy)
  const completed = Math.min(
    new Set(state.matchedRuleIds).size,
    Math.max(0, state.totalRuleCount),
  )
  const total = Math.max(0, state.totalRuleCount)
  const progress = total === 0 ? 0 : Math.round((completed / total) * 100)
  const action = busy ? null : actionLabel(state)
  const originMismatch =
    state.status === 'origin-mismatch' || state.error === 'ORIGIN_NOT_ALLOWED'
  const originAllowed = state.currentOriginAllowed && !originMismatch
  const originLabel = originMismatch
    ? '当前网站不匹配'
    : originAllowed
      ? '当前网站可验证'
      : '等待当前网站授权'

  return (
    <section
      data-testid="product-experience-card"
      aria-label="产品体验验证"
      className="relative mx-3 mt-3 overflow-hidden rounded-xl border border-slate-700 bg-slate-950 text-slate-50 shadow-[0_14px_28px_-22px_rgba(15,118,110,0.9)]"
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70 [background:radial-gradient(circle_at_88%_8%,rgba(45,212,191,0.18),transparent_34%),linear-gradient(135deg,rgba(255,255,255,0.035)_1px,transparent_1px)] [background-size:auto,11px_11px]"
      />
      <div className="relative p-3.5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[9px] font-black uppercase tracking-[0.2em] text-teal-300">
              Product check
            </p>
            <h2 className="mt-1 truncate text-[13px] font-bold text-white">
              {state.title ?? '产品体验任务'}
            </h2>
          </div>
          <span
            role="status"
            aria-live="polite"
            data-testid={
              state.status === 'verified' && !busy
                ? 'product-verified-badge'
                : undefined
            }
            className="mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/5 px-2 py-1 text-[9px] font-bold text-slate-200"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${copy.tone}`} />
            {copy.label}
          </span>
        </div>

        <div className="mt-3 flex items-end justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.13em] text-slate-500">
              Rules complete
            </p>
            <p className="mt-0.5 text-[18px] font-black tabular-nums text-white">
              {completed} <span className="text-slate-600">/</span> {total}
            </p>
          </div>
          <span
            data-testid="product-origin-status"
            className={`rounded-md border px-2 py-1 text-[9px] font-semibold ${
              originAllowed
                ? 'border-teal-400/20 bg-teal-400/10 text-teal-200'
                : 'border-slate-600 bg-slate-900 text-slate-400'
            }`}
          >
            {originLabel}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label="规则完成进度"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          className="mt-2 h-1.5 overflow-hidden rounded-full bg-slate-800"
        >
          <div
            className="h-full rounded-full bg-gradient-to-r from-teal-400 to-cyan-300 transition-[width] duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>

        <p className="mt-2.5 text-[10.5px] leading-relaxed text-slate-300">
          {copy.detail}
        </p>

        {state.zkTlsProgress && state.zkTlsProgress.length > 0 && (
          <ul className="mt-3 space-y-1.5 border-t border-white/8 pt-3">
            {state.zkTlsProgress.map((entry) => {
              return (
                <li
                  key={entry.ruleId}
                  className="flex items-center justify-between gap-3 text-[10px]"
                >
                  <span className="min-w-0 max-w-[44%] truncate text-slate-300">
                    {displayText(entry.title)}
                  </span>
                  <span className="max-w-[56%] truncate text-right font-bold tabular-nums text-teal-200">
                    {progressLabel(entry)}
                  </span>
                </li>
              )
            })}
          </ul>
        )}

        {action && (
          <div className="mt-3 grid grid-cols-[1fr_auto] items-center gap-3 border-t border-white/8 pt-3">
            <p className="text-[9.5px] leading-relaxed text-slate-400">
              只在本次授权的当前网站读取 Buyer 配置的完成标记
            </p>
            <button
              type="button"
              onClick={onStart}
              className="shrink-0 rounded-lg bg-teal-300 px-3 py-2 text-[10.5px] font-black text-slate-950 shadow-[0_6px_14px_-7px_rgba(94,234,212,0.9)] transition hover:bg-cyan-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-200"
            >
              {action}
            </button>
          </div>
        )}
      </div>
    </section>
  )
}
