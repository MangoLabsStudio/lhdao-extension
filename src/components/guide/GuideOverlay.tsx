import type { GuideState } from '@/lib/guide-state'

export type GuidePhase = 'unreserved' | 'detecting' | 'success' | 'error'

export interface GuideOverlayProps {
  reward: number
  phase: GuidePhase
  state: GuideState
  goalMs: number
  busy: boolean
  errorMsg?: string
  successReward?: number
  collapsed: boolean
  onReserve: () => void
  onVerify: () => void
  onDismiss: () => void
  onToggleCollapse: () => void
}

export function GuideOverlay(props: GuideOverlayProps) {
  if (props.collapsed) {
    return (
      <button
        type="button"
        className="lhg-ball"
        title="灯塔任务引导"
        onClick={props.onToggleCollapse}
      >
        🗼
      </button>
    )
  }

  const { state, goalMs } = props
  const dwellPct = Math.min(100, Math.round((state.dwellMs / goalMs) * 100))

  return (
    <div className="lhg-root">
      <div className="lhg-card">
        <div className="lhg-head">
          <span className="lhg-title">灯塔任务</span>
          <div>
            <button
              type="button"
              className="lhg-x"
              title="收起"
              onClick={props.onToggleCollapse}
            >
              －
            </button>
            <button
              type="button"
              className="lhg-x"
              title="关闭"
              onClick={props.onDismiss}
            >
              ✕
            </button>
          </div>
        </div>

        <div className="lhg-body">
          {props.phase === 'success' ? (
            <div className="lhg-success">
              <div className="big">
                🎉 +{props.successReward ?? props.reward} LUX
              </div>
              <button
                type="button"
                className="lhg-btn"
                onClick={props.onDismiss}
              >
                关闭
              </button>
            </div>
          ) : (
            <>
              <div className="lhg-reward">
                完成任务可得 <b>{props.reward} LUX</b>
              </div>

              {props.phase === 'unreserved' ? (
                <button
                  type="button"
                  className="lhg-btn"
                  disabled={props.busy}
                  onClick={props.onReserve}
                >
                  {props.busy ? '预约中…' : '预约席位'}
                </button>
              ) : (
                <>
                  {state.items.map((it) => (
                    <div className="lhg-item" key={it.key}>
                      <span className={`lhg-check${it.done ? ' done' : ''}`}>
                        ✓
                      </span>
                      <span>{it.label}</span>
                    </div>
                  ))}
                  <div className="lhg-dwell">
                    停留 {Math.floor(state.dwellMs / 1000)}/
                    {Math.floor(goalMs / 1000)}s
                    <div className="lhg-bar">
                      <i style={{ width: `${dwellPct}%` }} />
                    </div>
                  </div>
                  {props.errorMsg ? (
                    <div className="lhg-err">{props.errorMsg}</div>
                  ) : null}
                  <button
                    type="button"
                    className="lhg-btn"
                    disabled={!state.canVerify || props.busy}
                    onClick={props.onVerify}
                  >
                    {props.busy
                      ? '验证中…'
                      : state.canVerify
                        ? '验证发奖'
                        : '完成上面步骤解锁'}
                  </button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
