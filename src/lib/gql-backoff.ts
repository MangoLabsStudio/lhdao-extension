export function parseRetryAfterMs(
  value: string | null,
  now = Date.now(),
): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.ceil(seconds * 1000)
  }
  const date = Date.parse(value)
  if (!Number.isFinite(date)) return undefined
  return Math.max(0, date - now)
}

export function withBackoffJitter(
  delayMs: number,
  random: () => number = Math.random,
): number {
  return Math.ceil(delayMs + delayMs * 0.2 * random())
}
