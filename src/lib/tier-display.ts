/** Keep backend tier values intact; only rename the public F label. */
export function tierDisplay(tier: string | null | undefined): string {
  return tier === 'F' ? 'D-' : (tier ?? '—')
}
