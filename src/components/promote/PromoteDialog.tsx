import * as React from 'react'
import { sendMessage } from '@/lib/messaging'
import { isPluginDeviceDenied } from '@/lib/plugin-device-recovery'
import type { PromoteTweetPricingQuote } from '@/lib/queries'
import type { MsgResponse, PromoteAction } from '@/types/messages'

/**
 * 一键推广 UI(Shadow DOM React)—— 对齐系统「推文加热」:按 tier 招募人数定价,
 * 每个动作建一个独立 ENGAGEMENT 子单,各子单 ≥ 2 LUX。
 *
 * 录入:选动作(赞/转/评)+ 每 tier 招募人数(同一组人数应用到每个所选动作)。
 * 金额只展示服务端冻结报价,确认时原样提交 quoteId。
 * 快捷:↻ 按上次配置;🔁 持续复投(成功后给作者建 auto-reinvest)。
 */

const ALL_ACTIONS: { key: PromoteAction; label: string }[] = [
  { key: 'LIKE', label: '赞' },
  { key: 'RT', label: '转发' },
  { key: 'COMMENT', label: '评论' },
]
const ALL_TIERS = ['A', 'B', 'C', 'D']

type LastConfig = {
  actions: PromoteAction[]
  slots: Record<string, number>
  reinvest: boolean
  reinvestCount: number
}
const LAST_KEY = 'lhdao:promote:last'

function loadLast(): LastConfig | null {
  try {
    const raw = localStorage.getItem(LAST_KEY)
    return raw ? (JSON.parse(raw) as LastConfig) : null
  } catch {
    return null
  }
}

function RocketIcon() {
  return (
    <svg
      className="lh-promote-ico"
      viewBox="0 0 24 24"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
      <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
    </svg>
  )
}

export function PromoteButton({ onOpen }: { onOpen: () => void }) {
  return (
    <button
      type="button"
      className="lh-promote-btn"
      onClick={onOpen}
      title="一键推广这条推文"
    >
      <RocketIcon />
      <span className="lh-promote-txt">推广</span>
    </button>
  )
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="44"
      height="44"
      fill="none"
      stroke="#2DD4BF"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" stroke="#99F6E4" />
      <path d="m8 12 2.5 2.5L16 9" />
    </svg>
  )
}

/** 动作图标(currentColor,自动跟随 chip 选中/hover 态变色)。 */
function ActionGlyph({ kind }: { kind: PromoteAction }) {
  if (kind === 'LIKE') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
      </svg>
    )
  }
  if (kind === 'RT') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="15"
        height="15"
        fill="currentColor"
        aria-hidden="true"
      >
        <path d="M4.5 3.88l4.43 4.14-1.36 1.46L5.5 7.55V16c0 .55.45 1 1 1H13v2H6.5c-1.65 0-3-1.35-3-3V7.55L1.43 9.48.07 8.02 4.5 3.88zM16 7h-6V5h6.5c1.65 0 3 1.35 3 3v8.45l2.07-1.93 1.36 1.46L18.5 20.12l-4.43-4.14 1.36-1.46L17.5 16.45V8c0-.55-.45-1-1-1z" />
      </svg>
    )
  }
  // COMMENT
  return (
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  )
}

type Phase = 'form' | 'loading' | 'done' | 'error'
type PreviewState = 'idle' | 'loading' | 'ready' | 'error'
type PromoteRequest = {
  type: 'promote-tweet'
  tweetUrl: string
  actions: { actionType: PromoteAction; tierSlots: Record<string, number> }[]
  quoteId: string
  reinvestCount: number
}

const QUOTE_REFRESH_CODES = new Set([
  'ENGAGEMENT_PILOT_QUOTE_EXPIRED',
  'ENGAGEMENT_PILOT_QUOTE_REVOKED',
  'ENGAGEMENT_PILOT_QUOTE_NOT_FOUND',
  'ENGAGEMENT_PILOT_QUOTE_MISMATCH',
  'ENGAGEMENT_PILOT_QUOTE_INVALID',
])
const UNCERTAIN_PROMOTE_CODES = new Set([
  'INTERNAL',
  'ENGAGEMENT_PILOT_QUOTE_UNAVAILABLE',
  'ENGAGEMENT_PILOT_QUOTE_STORAGE_UNAVAILABLE',
])

function pricingErrorMessage(code: string, fallback: string) {
  if (
    code === 'PLUGIN_UPGRADE_REQUIRED' ||
    code === 'ENGAGEMENT_PILOT_QUOTE_REQUIRED'
  ) {
    return '当前插件协议不支持报价确认，请升级后重试；若已升级，请稍后再试。'
  }
  if (QUOTE_REFRESH_CODES.has(code)) return '报价已变化，请重新确认最新价格。'
  if (code === 'NO_TOKEN') return '请先连接 Lighthouse 账户。'
  return fallback || '报价获取失败，请重试。'
}

function remainingTime(expiresAt: string, nowMs: number) {
  const seconds = Math.max(0, Math.ceil((Date.parse(expiresAt) - nowMs) / 1000))
  const minutes = Math.floor(seconds / 60)
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`
}

export function PromoteDialog({
  tweetUrl,
  onClose,
}: {
  tweetUrl: string
  onClose: () => void
}) {
  // 默认全空:不预选动作、不预填人数,让用户自己选(可用「按上次配置」一键回填)
  const [actions, setActions] = React.useState<PromoteAction[]>([])
  const [slots, setSlots] = React.useState<Record<string, number>>({})
  const [reinvest, setReinvest] = React.useState(false)
  const [reinvestCount, setReinvestCount] = React.useState(3)
  const [phase, setPhase] = React.useState<Phase>('form')
  const [errMsg, setErrMsg] = React.useState('')
  const [balance, setBalance] = React.useState<number | null>(null)
  const [doneMsg, setDoneMsg] = React.useState('')
  const [quote, setQuote] = React.useState<PromoteTweetPricingQuote | null>(
    null,
  )
  const [previewState, setPreviewState] = React.useState<PreviewState>('idle')
  const [previewError, setPreviewError] = React.useState('')
  const [refreshKey, setRefreshKey] = React.useState(0)
  const [nowMs, setNowMs] = React.useState(() => Date.now())
  const previewSequence = React.useRef(0)
  const submitSequence = React.useRef(0)
  const submittingRef = React.useRef(false)
  const mountedRef = React.useRef(true)
  const [retryRequest, setRetryRequest] = React.useState<PromoteRequest | null>(
    null,
  )
  const [deviceDenied, setDeviceDenied] = React.useState(false)
  const [reconnectState, setReconnectState] = React.useState<
    'idle' | 'loading' | 'started'
  >('idle')

  const last = React.useMemo(loadLast, [])

  React.useEffect(() => {
    void sendMessage({ type: 'get-balance' }).then((r) => {
      if (r.type === 'balance-result') setBalance(r.balance)
    })
  }, [])

  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      previewSequence.current += 1
      submitSequence.current += 1
    }
  }, [])

  React.useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1_000)
    return () => clearInterval(timer)
  }, [])

  const invalidateQuote = () => {
    if (submittingRef.current) return
    previewSequence.current += 1
    setQuote(null)
    setPreviewState('idle')
    setPreviewError('')
    setPhase('form')
    setErrMsg('')
    setRetryRequest(null)
  }
  const toggleAction = (a: PromoteAction) => {
    if (submittingRef.current) return
    invalidateQuote()
    setActions((prev) =>
      prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a],
    )
  }
  const setSlot = (tier: string, v: number) => {
    if (submittingRef.current) return
    invalidateQuote()
    setSlots((prev) => ({ ...prev, [tier]: Math.max(0, Math.trunc(v) || 0) }))
  }

  const applyLast = () => {
    if (!last || submittingRef.current) return
    invalidateQuote()
    setActions(last.actions)
    setSlots(last.slots)
    setReinvest(last.reinvest)
    setReinvestCount(last.reinvestCount || 3)
  }

  const totalSlots = ALL_TIERS.reduce((s, t) => s + (slots[t] ?? 0), 0)
  const payloadActions = React.useMemo(
    () =>
      actions.map((actionType) => {
        const tierSlots: Record<string, number> = {}
        for (const tier of ALL_TIERS) {
          if ((slots[tier] ?? 0) > 0) tierSlots[tier] = slots[tier]
        }
        return { actionType, tierSlots }
      }),
    [actions, slots],
  )
  const hasQuoteInput = actions.length > 0 && totalSlots > 0

  React.useEffect(() => {
    void refreshKey
    setQuote(null)
    setPreviewError('')
    if (!hasQuoteInput) {
      setPreviewState('idle')
      return
    }
    const sequence = ++previewSequence.current
    const controller = new AbortController()
    setPreviewState('loading')
    const timer = setTimeout(() => {
      void sendMessage({
        type: 'preview-promote-tweet-pricing',
        tweetUrl,
        actions: payloadActions,
      })
        .then((response) => {
          if (
            controller.signal.aborted ||
            sequence !== previewSequence.current
          ) {
            return
          }
          if (response.type === 'promote-pricing-result' && response.ok) {
            setQuote(response.quote)
            setPreviewState('ready')
            return
          }
          const code =
            response.type === 'promote-pricing-result'
              ? response.code
              : 'INTERNAL'
          const message =
            response.type === 'promote-pricing-result'
              ? response.message
              : '报价获取失败，请重试。'
          setPreviewError(pricingErrorMessage(code, message))
          setPreviewState('error')
        })
        .catch(() => {
          if (
            controller.signal.aborted ||
            sequence !== previewSequence.current
          ) {
            return
          }
          setPreviewError('报价获取失败，请刷新后重试。')
          setPreviewState('error')
        })
    }, 250)
    return () => {
      controller.abort()
      clearTimeout(timer)
    }
  }, [hasQuoteInput, payloadActions, refreshKey, tweetUrl])

  React.useEffect(() => {
    if (!quote || Date.parse(quote.expiresAt) > nowMs) return
    previewSequence.current += 1
    setQuote(null)
    setPreviewState('error')
    setPreviewError('报价已过期，请刷新后重新确认。')
    setRetryRequest(null)
  }, [nowMs, quote])

  const canSubmit =
    phase === 'form' &&
    previewState === 'ready' &&
    quote !== null &&
    Date.parse(quote.expiresAt) > nowMs

  const refreshQuote = () => {
    if (submittingRef.current) return
    setPhase('form')
    setErrMsg('')
    setRetryRequest(null)
    setRefreshKey((value) => value + 1)
  }

  const submit = async (sameRequest?: PromoteRequest) => {
    if (submittingRef.current) return
    if (!sameRequest && (!quote || Date.parse(quote.expiresAt) <= Date.now())) {
      setPreviewError('报价已过期，请刷新后重新确认。')
      setQuote(null)
      setPreviewState('error')
      return
    }
    const request =
      sameRequest ??
      ({
        type: 'promote-tweet',
        tweetUrl,
        actions: payloadActions,
        quoteId: quote!.quoteId,
        reinvestCount: reinvest ? reinvestCount : 0,
      } satisfies PromoteRequest)
    submittingRef.current = true
    const sequence = ++submitSequence.current
    setDeviceDenied(false)
    setReconnectState('idle')
    setPhase('loading')
    setErrMsg('')
    let r: MsgResponse
    try {
      r = await sendMessage(request)
    } catch {
      r = {
        type: 'promote-result' as const,
        ok: false as const,
        code: 'INTERNAL',
        message: '插件通信中断，结果可能仍在处理中。',
      }
    }
    if (!mountedRef.current || sequence !== submitSequence.current) return
    submittingRef.current = false
    if (r.type === 'promote-result' && r.ok) {
      setRetryRequest(null)
      try {
        localStorage.setItem(
          LAST_KEY,
          JSON.stringify({ actions, slots, reinvest, reinvestCount }),
        )
      } catch {}
      setDoneMsg(
        `已为 ${r.campaignIds.length} 个动作建单${r.reinvested ? ' · 已开启持续复投' : ''}`,
      )
      setPhase('done')
    } else if (r.type === 'promote-result') {
      if (QUOTE_REFRESH_CODES.has(r.code)) {
        setPhase('form')
        setQuote(null)
        setPreviewState('error')
        setPreviewError(pricingErrorMessage(r.code, r.message))
        setRetryRequest(null)
        return
      }
      const denied =
        isPluginDeviceDenied(r.code) || isPluginDeviceDenied(r.message)
      const authDenied = denied || r.code === 'TOKEN_INVALID'
      setDeviceDenied(authDenied)
      if (UNCERTAIN_PROMOTE_CODES.has(r.code)) {
        setRetryRequest(request)
      } else {
        setRetryRequest(null)
      }
      setErrMsg(
        authDenied
          ? '设备授权已失效，请重新连接后再推广。'
          : pricingErrorMessage(r.code, r.message || '推广失败,请重试'),
      )
      setPhase('error')
    } else {
      setRetryRequest(request)
      setErrMsg('插件通信中断，结果可能仍在处理中。')
      setPhase('error')
    }
  }

  const reconnect = async () => {
    if (reconnectState !== 'idle') return
    setReconnectState('loading')
    const r = await sendMessage({ type: 'start-pairing' })
    if (r.type === 'pairing-started' && r.ok) {
      setReconnectState('started')
      return
    }
    setReconnectState('idle')
    if (r.type === 'pairing-started') setErrMsg(r.reason)
  }

  return (
    <div
      className="lh-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="lh-promote-title"
    >
      <button
        type="button"
        className="lh-overlay-dismiss"
        aria-label="关闭推广窗口"
        disabled={phase === 'loading'}
        onClick={onClose}
      />
      <div className="lh-modal">
        <div className="lh-head">
          <span id="lh-promote-title" className="lh-title">
            <RocketIcon />
            一键推广这条推文
          </span>
          <button
            type="button"
            className="lh-x"
            aria-label="关闭推广窗口"
            disabled={phase === 'loading'}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        {phase === 'done' ? (
          <div className="lh-result">
            <div className="lh-result-emoji">
              <CheckIcon />
            </div>
            <div className="lh-result-title">推广已发布!</div>
            <div className="lh-result-sub">{doneMsg}</div>
            <button type="button" className="lh-primary" onClick={onClose}>
              完成
            </button>
          </div>
        ) : (
          <>
            {last && (
              <button
                type="button"
                className="lh-quick"
                disabled={phase === 'loading'}
                onClick={applyLast}
              >
                ↻ 按上次配置
              </button>
            )}

            <div className="lh-label">互动动作(每个动作单独建单)</div>
            <div className="lh-chips">
              {ALL_ACTIONS.map((a) => (
                <button
                  type="button"
                  key={a.key}
                  className={
                    actions.includes(a.key) ? 'lh-chip lh-chip-on' : 'lh-chip'
                  }
                  disabled={phase === 'loading'}
                  onClick={() => toggleAction(a.key)}
                >
                  <ActionGlyph kind={a.key} />
                  <span>{a.label}</span>
                </button>
              ))}
            </div>

            <div className="lh-label">每档招募人数(应用到每个动作)</div>
            <div className="lh-tiers">
              {ALL_TIERS.map((t) => (
                <div key={t} className="lh-tier">
                  <span className="lh-tier-name">{t} 档</span>
                  <input
                    className="lh-num"
                    type="number"
                    min={0}
                    placeholder="0"
                    value={slots[t] || ''}
                    disabled={phase === 'loading'}
                    onChange={(e) => setSlot(t, Number(e.currentTarget.value))}
                  />
                </div>
              ))}
            </div>

            <label className="lh-reinvest">
              <input
                type="checkbox"
                checked={reinvest}
                disabled={phase === 'loading'}
                onChange={(e) => {
                  if (submittingRef.current) return
                  setRetryRequest(null)
                  setPhase('form')
                  setErrMsg('')
                  setReinvest(e.currentTarget.checked)
                }}
              />
              <span>持续复投这个用户</span>
              {reinvest && (
                <input
                  className="lh-num lh-num-sm"
                  type="number"
                  min={1}
                  disabled={phase === 'loading'}
                  value={reinvestCount}
                  onChange={(e) => {
                    if (submittingRef.current) return
                    setRetryRequest(null)
                    setPhase('form')
                    setErrMsg('')
                    setReinvestCount(
                      Math.max(
                        1,
                        Math.trunc(Number(e.currentTarget.value)) || 1,
                      ),
                    )
                  }}
                />
              )}
            </label>
            {reinvest && (
              <div className="lh-fine">
                作者发新推文时自动复投 {reinvestCount} 次
              </div>
            )}

            {previewState === 'loading' && (
              <div className="lh-quote-status" role="status">
                正在获取服务端报价…
              </div>
            )}
            {quote && (
              <section
                className="lh-quote"
                aria-labelledby="lh-promote-quote-title"
              >
                <div className="lh-quote-head">
                  <span id="lh-promote-quote-title">服务端报价</span>
                  <b>{quote.totalCost} LUX</b>
                </div>
                <div className="lh-quote-meta">
                  本金 {quote.principal} · 手续费 {quote.promotionFee} LUX
                  {balance != null && (
                    <span className="lh-bal"> · 余额 {balance.toFixed(1)}</span>
                  )}
                </div>
                <div className="lh-quote-expiry">
                  {new Date(quote.expiresAt).toISOString()} UTC 前有效 · 剩余{' '}
                  {remainingTime(quote.expiresAt, nowMs)}
                </div>
                <div className="lh-quote-scroll">
                  <table className="lh-quote-table">
                    <thead>
                      <tr>
                        <th scope="col">动作/档</th>
                        <th scope="col">来源</th>
                        <th scope="col">今日</th>
                        <th scope="col">明日预计</th>
                        <th scope="col">数量</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quote.lines.map((line) => (
                        <tr
                          key={`${line.campaignIndex}:${line.actionType}:${line.tier}`}
                        >
                          <td>
                            {line.actionType}/{line.tier}
                          </td>
                          <td>
                            {line.pricingSource === 'PILOT' ? '试点' : '正式价'}
                          </td>
                          <td>今日 {line.todayPrice}</td>
                          <td>明日预计 {line.tomorrowExpectedPrice}</td>
                          <td>{line.quantity}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {quote.lines
                  .filter((line) => line.schedule?.length)
                  .map((line) => (
                    <section
                      key={`schedule:${line.campaignIndex}:${line.actionType}:${line.tier}`}
                      className="lh-schedule-wrap"
                      aria-label={`${line.actionType}/${line.tier} 价格日程`}
                    >
                      <b>
                        {line.actionType}/{line.tier} 价格日程
                      </b>
                      <div className="lh-schedule">
                        {line.schedule!.map((point) => (
                          <span key={point.dayIndex}>
                            第 {point.dayIndex} 日 {point.unitPrice}
                          </span>
                        ))}
                      </div>
                    </section>
                  ))}
              </section>
            )}
            {previewError && <div className="lh-warn">{previewError}</div>}
            {previewState === 'error' && hasQuoteInput && (
              <button
                type="button"
                className="lh-secondary"
                onClick={refreshQuote}
              >
                刷新报价
              </button>
            )}
            {phase === 'error' && <div className="lh-warn">{errMsg}</div>}
            {phase === 'error' && retryRequest && (
              <button
                type="button"
                className="lh-secondary"
                onClick={() => void submit(retryRequest)}
              >
                重试同一请求
              </button>
            )}
            {phase === 'error' && deviceDenied && (
              <button
                type="button"
                className="lh-primary"
                disabled={reconnectState !== 'idle'}
                onClick={reconnect}
              >
                {reconnectState === 'loading'
                  ? '正在打开连接页面…'
                  : reconnectState === 'started'
                    ? '请在新页面完成连接'
                    : '重新连接'}
              </button>
            )}

            <button
              type="button"
              className="lh-primary"
              disabled={!canSubmit || deviceDenied}
              onClick={() => void submit()}
            >
              {phase === 'loading' ? '提交中…' : '确认推广'}
            </button>
            <div className="lh-fine">
              价格由 Lighthouse 服务端冻结；确认后才会扣款
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export const promoteButtonCss = `
  :host { all: initial; }
  .lh-promote-btn {
    display: inline-flex; align-items: center; gap: 5px;
    padding: 4px 11px 4px 9px; margin-left: 2px;
    border: none; border-radius: 999px;
    background: linear-gradient(135deg, #0EA5A4 0%, #0891B2 100%);
    color: #fff;
    font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    font-size: 12.5px; font-weight: 700; line-height: 1; letter-spacing: 0.01em;
    cursor: pointer; user-select: none;
    box-shadow:
      0 1px 2px rgba(8,145,178,0.35),
      inset 0 1px 0 rgba(255,255,255,0.28);
    transition: transform .12s ease, box-shadow .12s ease, filter .12s ease;
    -webkit-font-smoothing: antialiased;
  }
  .lh-promote-btn:hover {
    filter: brightness(1.05);
    box-shadow:
      0 3px 10px -1px rgba(8,145,178,0.5),
      inset 0 1px 0 rgba(255,255,255,0.32);
    transform: translateY(-0.5px);
  }
  .lh-promote-btn:active { transform: translateY(0); box-shadow: 0 1px 2px rgba(8,145,178,0.4); }
  .lh-promote-ico { display: block; flex-shrink: 0; }
  .lh-promote-txt { line-height: 1; }
`

export const promoteDialogCss = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
  @keyframes lh-fade { from { opacity: 0 } to { opacity: 1 } }
  @keyframes lh-pop { from { transform: translateY(10px) scale(.97); opacity: 0 } to { transform: none; opacity: 1 } }
  .lh-overlay {
    position: fixed; inset: 0; z-index: 2147483647;
    display: flex; align-items: center; justify-content: center;
    animation: lh-fade .15s ease;
  }
  .lh-overlay-dismiss {
    position: absolute; inset: 0; width: 100%; height: 100%; padding: 0;
    border: 0; background: rgba(8,12,18,0.64); cursor: default;
    -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);
  }
  .lh-modal {
    position: relative;
    width: 374px; max-width: calc(100vw - 32px); max-height: calc(100vh - 48px); overflow-y: auto;
    background: linear-gradient(180deg, #141d27 0%, #0c131b 100%);
    color: #e6ecf3;
    border: 1px solid rgba(255,255,255,0.07);
    border-radius: 20px; padding: 20px;
    box-shadow: 0 30px 70px -20px rgba(0,0,0,0.78), inset 0 1px 0 rgba(255,255,255,0.06);
    animation: lh-pop .2s cubic-bezier(.2,.9,.3,1.05);
  }
  .lh-modal::-webkit-scrollbar { width: 8px; }
  .lh-modal::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 8px; }
  .lh-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .lh-title { display: inline-flex; align-items: center; gap: 7px; font-size: 15.5px; font-weight: 800; color: #f3f6fa; letter-spacing: .01em; }
  .lh-title svg { stroke: #2DD4BF; flex-shrink: 0; }
  .lh-x { margin-left: auto; border: none; background: rgba(255,255,255,0.05); width: 27px; height: 27px; border-radius: 9px; font-size: 13px; cursor: pointer; color: #8b97a6; display: inline-flex; align-items: center; justify-content: center; transition: all .12s ease; }
  .lh-x:hover { background: rgba(255,255,255,0.1); color: #d6dde6; }
  .lh-quick {
    width: 100%; margin-bottom: 14px; padding: 9px;
    border: 1px solid rgba(45,212,191,0.28); border-radius: 12px;
    background: rgba(45,212,191,0.08); color: #5eead4;
    font-size: 13px; font-weight: 700; cursor: pointer; transition: background .12s ease;
  }
  .lh-quick:hover { background: rgba(45,212,191,0.15); }
  .lh-label { font-size: 11px; font-weight: 700; color: #7c8a9a; margin: 15px 0 8px; text-transform: uppercase; letter-spacing: .07em; }
  .lh-chips { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .lh-chip {
    display: flex; align-items: center; justify-content: center; gap: 6px;
    padding: 9px 0; border: 1px solid rgba(255,255,255,0.1); border-radius: 12px;
    background: rgba(255,255,255,0.03); color: #aeb9c6; font-size: 13px; font-weight: 700; cursor: pointer;
    transition: all .12s ease;
  }
  .lh-chip svg { flex-shrink: 0; }
  .lh-chip:hover { border-color: rgba(255,255,255,0.22); color: #d6dde6; }
  .lh-chip-on {
    border-color: transparent;
    background: linear-gradient(135deg, #0EA5A4 0%, #0891B2 100%); color: #fff;
    box-shadow: 0 2px 10px -2px rgba(8,145,178,0.55), inset 0 1px 0 rgba(255,255,255,0.22);
  }
  .lh-tiers { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
  .lh-tier {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    border: 1px solid rgba(255,255,255,0.08); border-radius: 12px; padding: 8px 11px;
    background: rgba(255,255,255,0.02);
  }
  .lh-tier-name { font-size: 12.5px; font-weight: 700; color: #aeb9c6; }
  .lh-num {
    width: 76px; padding: 7px 9px; border: 1px solid rgba(255,255,255,0.1); border-radius: 9px;
    font-size: 14px; font-weight: 700; outline: none; text-align: right;
    background: rgba(0,0,0,0.28); color: #f1f5f9; -moz-appearance: textfield;
  }
  .lh-num::placeholder { color: #4a5663; font-weight: 700; }
  .lh-num::-webkit-inner-spin-button, .lh-num::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
  .lh-num:focus { border-color: #2DD4BF; box-shadow: 0 0 0 3px rgba(45,212,191,0.16); }
  .lh-num-sm { width: 60px; margin-left: 10px; }
  .lh-reinvest { display: flex; align-items: center; gap: 9px; margin-top: 16px; font-size: 13px; font-weight: 700; color: #c4ccd6; cursor: pointer; }
  .lh-reinvest input[type=checkbox] { width: 17px; height: 17px; accent-color: #0EA5A4; cursor: pointer; }
  .lh-quote-status { margin-top: 14px; font-size: 12px; color: #7dd3fc; }
  .lh-quote {
    margin-top: 14px; padding: 12px; min-width: 0; overflow: hidden;
    border: 1px solid rgba(45,212,191,0.22); border-radius: 14px;
    background: linear-gradient(145deg, rgba(14,165,164,0.12), rgba(8,145,178,0.05));
  }
  .lh-quote-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; color: #a7f3d0; font-size: 12px; font-weight: 800; }
  .lh-quote-head b { color: #f0fdfa; font-size: 16px; white-space: nowrap; }
  .lh-quote-meta, .lh-quote-expiry { margin-top: 5px; color: #8ea0b3; font-size: 10.5px; line-height: 1.45; }
  .lh-quote-scroll { margin-top: 10px; max-width: 100%; overflow-x: auto; }
  .lh-quote-table { width: 100%; min-width: 480px; border-collapse: collapse; font-size: 10.5px; text-align: left; }
  .lh-quote-table th { padding: 6px; color: #64748b; font-weight: 700; white-space: nowrap; border-bottom: 1px solid rgba(255,255,255,0.08); }
  .lh-quote-table td { padding: 7px 6px; color: #cbd5e1; white-space: nowrap; border-bottom: 1px solid rgba(255,255,255,0.05); }
  .lh-schedule { display: flex; gap: 6px; margin-top: 9px; padding-bottom: 2px; overflow-x: auto; }
  .lh-schedule span { flex: 0 0 auto; padding: 5px 7px; border-radius: 7px; background: rgba(15,23,42,0.65); color: #94a3b8; font-size: 10px; }
  .lh-schedule-wrap { margin-top: 9px; min-width: 0; }
  .lh-schedule-wrap > b { color: #a5f3fc; font-size: 10.5px; }
  .lh-bal { color: #7c8a9a; font-weight: 600; }
  .lh-warn { margin-top: 8px; font-size: 12.5px; font-weight: 700; color: #f87171; }
  .lh-primary {
    width: 100%; margin-top: 16px; padding: 12px; border: none; border-radius: 13px;
    background: linear-gradient(135deg, #0EA5A4 0%, #06B6D4 100%);
    color: #fff; font-size: 14.5px; font-weight: 800; cursor: pointer; letter-spacing: .02em;
    box-shadow: 0 8px 20px -6px rgba(8,145,178,0.55), inset 0 1px 0 rgba(255,255,255,0.26);
    transition: filter .12s ease, transform .1s ease;
  }
  .lh-primary:hover:not(:disabled) { filter: brightness(1.06); }
  .lh-primary:active:not(:disabled) { transform: translateY(1px); }
  .lh-primary:disabled { opacity: 0.42; cursor: not-allowed; box-shadow: none; }
  .lh-secondary { width: 100%; margin-top: 10px; padding: 9px; border: 1px solid rgba(103,232,249,0.3); border-radius: 11px; background: rgba(8,145,178,0.08); color: #a5f3fc; font-size: 12px; font-weight: 800; cursor: pointer; }
  .lh-primary:focus-visible, .lh-secondary:focus-visible, .lh-chip:focus-visible, .lh-quick:focus-visible, .lh-x:focus-visible { outline: 2px solid #67e8f9; outline-offset: 2px; }
  .lh-fine { margin-top: 10px; font-size: 11px; color: #5b6675; text-align: center; }
  .lh-result { text-align: center; padding: 14px 4px 4px; }
  .lh-result-emoji { display: flex; justify-content: center; }
  .lh-result-title { font-size: 17px; font-weight: 800; margin-top: 8px; color: #f3f6fa; }
  .lh-result-sub { font-size: 13px; color: #8b97a6; margin-top: 5px; }
  .lh-result .lh-primary { margin-top: 18px; }
`
