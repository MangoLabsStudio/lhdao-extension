type Kind = 'current' | 'claim' | 'loading' | 'order' | 'unavailable'

const labels: Record<Kind, string> = {
  current: '灯塔严选',
  claim: '接单时严选',
  loading: '资格确认中',
  order: '仅灯塔严选可接',
  unavailable: '严选资格暂时无法确认',
}

export function LighthouseSelectedText({ kind }: { kind: Kind }) {
  return (
    <span
      className="lh-selected-text"
      style={{ color: '#0d9488', fontSize: 11, fontWeight: 600 }}
    >
      {labels[kind]}
    </span>
  )
}
