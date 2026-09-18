// ─────────────────────────────────────────────────────────────────────────
// [profile 关注任务卡] 注入在被关注目标的 X 个人主页头部。给用户三件事:
//   ① 指示「这是关注任务,关注 @handle 领 X LUX」
//   ② 引导点上方被高亮的原生「关注」按钮(高亮由 content.ts 贴 glow 属性)
//   ③ 一个主按钮:未接取→接取;已接取→验证(走插件签名 verifyOnly)→成功跳回 lhdao
// 关注**无停留(dwell)要求**(方案 B 的 dwell 闸只作用于 LIKE/RT)。
// Shadow DOM 内渲染,用 inline style 自包含(不依赖 Tailwind 包)。
// ─────────────────────────────────────────────────────────────────────────

import { useState } from 'react'
import { sendMessage } from '@/lib/messaging'

interface Props {
  campaignId: string
  targetHandle: string
  reward: number
  reserved: boolean
  /** 主页上是否找到原生「关注」按钮(已高亮)。已关注则无,文案随之变。 */
  followButtonPresent: boolean
}

type Phase = 'idle' | 'reserving' | 'verifying' | 'success' | 'error'

const msgOf = (r: unknown, fallback: string): string => {
  if (r && typeof r === 'object' && 'message' in r) {
    const m = (r as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  return fallback
}

export function ProfileFollowCard({
  campaignId,
  targetHandle,
  reward,
  reserved: reservedInit,
  followButtonPresent,
}: Props) {
  const [reserved, setReserved] = useState(reservedInit)
  const [phase, setPhase] = useState<Phase>('idle')
  const [err, setErr] = useState('')

  const onReserve = async (): Promise<void> => {
    setPhase('reserving')
    setErr('')
    try {
      const r = await sendMessage({ type: 'reserve-task', campaignId })
      if (r.type === 'reserve-result' && r.ok) {
        setReserved(true)
        setPhase('idle')
      } else {
        setErr(msgOf(r, '接取失败，请稍后重试'))
        setPhase('error')
      }
    } catch {
      setErr('接取失败，请稍后重试')
      setPhase('error')
    }
  }

  const onVerify = async (): Promise<void> => {
    setPhase('verifying')
    setErr('')
    try {
      const r = await sendMessage({ type: 'verify-task', campaignId })
      if (r.type === 'verify-result' && r.ok) {
        setPhase('success')
        // 把票据证据(签名 proof)已交后端 → 跳回 lhdao 任务页看结果
        void sendMessage({ type: 'open-campaign', campaignId }).catch(() => {})
      } else {
        setErr(msgOf(r, '未检测到关注，请先点上方高亮的「关注」按钮'))
        setPhase('error')
      }
    } catch {
      setErr('验证失败，请稍后重试')
      setPhase('error')
    }
  }

  const busy = phase === 'reserving' || phase === 'verifying'
  const primaryLabel =
    phase === 'success'
      ? '✓ 已提交，正在跳转…'
      : phase === 'verifying'
        ? '验证中…'
        : phase === 'reserving'
          ? '接取中…'
          : reserved
            ? '我已关注，验证'
            : '接取任务'
  const onPrimary = reserved ? onVerify : onReserve

  const hint = !reserved
    ? `先「接取任务」，再点${followButtonPresent ? '上方高亮的' : ''}「关注」按钮`
    : followButtonPresent
      ? '点上方高亮的「关注」按钮完成关注，再验证'
      : `确认已关注 @${targetHandle} 后点验证`

  return (
    <div
      style={{
        boxSizing: 'border-box',
        width: '100%',
        margin: '10px 0',
        padding: '12px 14px',
        borderRadius: 14,
        border: '1px solid rgba(20,184,166,0.35)',
        background:
          'linear-gradient(135deg, rgba(20,184,166,0.10), rgba(6,182,212,0.08))',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        color: '#0f172a',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 14,
          fontWeight: 700,
        }}
      >
        <span
          style={{
            display: 'inline-flex',
            width: 20,
            height: 20,
            borderRadius: 6,
            alignItems: 'center',
            justifyContent: 'center',
            background: 'linear-gradient(135deg,#14b8a6,#06b6d4)',
            color: '#fff',
            fontSize: 12,
          }}
        >
          ✦
        </span>
        <span>Lighthouse 关注任务</span>
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 13,
            fontWeight: 800,
            color: '#0d9488',
          }}
        >
          +{reward} LUX
        </span>
      </div>

      <div style={{ marginTop: 6, fontSize: 13, color: '#334155' }}>
        关注 <b>@{targetHandle}</b> 完成任务
      </div>
      <div style={{ marginTop: 2, fontSize: 12, color: '#64748b' }}>{hint}</div>

      {phase === 'error' && err ? (
        <div style={{ marginTop: 6, fontSize: 12, color: '#dc2626' }}>
          {err}
        </div>
      ) : null}

      <button
        type="button"
        onClick={() => void onPrimary()}
        disabled={busy || phase === 'success'}
        style={{
          marginTop: 10,
          width: '100%',
          padding: '8px 12px',
          borderRadius: 10,
          border: 'none',
          cursor: busy || phase === 'success' ? 'default' : 'pointer',
          fontSize: 13,
          fontWeight: 700,
          color: '#fff',
          background:
            busy || phase === 'success'
              ? '#94a3b8'
              : 'linear-gradient(135deg,#14b8a6,#06b6d4)',
          transition: 'opacity .15s',
        }}
      >
        {primaryLabel}
      </button>
    </div>
  )
}
