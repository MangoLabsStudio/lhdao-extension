type Kind = 'current' | 'claim' | 'order'

const labels: Record<Kind, string> = {
  current: '灯塔严选',
  claim: '接单时严选',
  order: '仅灯塔严选可接',
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
