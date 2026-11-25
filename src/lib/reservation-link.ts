// Both content scripts share the extension's isolated window. Keep the launch
// fragment if X replaces /i/status with the author's URL before document_idle.
type ReservationWindow = Window & { __lhdaoReservationFragment?: string }

export function rememberReservationLink() {
  if (location.hash.includes('lhdaoTask=')) {
    const isolatedWindow = window as ReservationWindow
    isolatedWindow.__lhdaoReservationFragment = location.hash
  }
}

export function requestedCampaignId(tweetId: string | null): string | null {
  if (!tweetId) return null
  const fragment = location.hash.includes('lhdaoTask=')
    ? location.hash
    : (window as ReservationWindow).__lhdaoReservationFragment
  const marker = new URLSearchParams(fragment?.slice(1))
    .getAll('lhdaoTask')
    .at(-1)
  const match = marker?.match(/^(\d+):([\w-]{1,128})$/)
  return match?.[1] === tweetId ? match[2] : null
}
