import type { Json } from './discovery/redaction'

export type ProofReviewSnapshot = {
  id: string
  connectorId: string
  title: string
  pageOrigin: string
  pagePath: string
  targetOrigin: string
  requestPath: string
  method: string
  capturedAt: number
  expiresAt: number
  account: {
    source: 'response' | 'verified-binding'
    observed: string | null
    expected: string | null
    status: 'matched' | 'mismatch' | 'unknown'
  }
  request: Json
  requestAccounts: Array<{ name: string; value: string }>
  response: Json | null
  responseState:
    | 'json'
    | 'empty'
    | 'non-json'
    | 'oversize'
    | 'unavailable'
    | 'invalid'
  values: Array<{ output: string; value: string; unit: string | null }>
  canConfirm: boolean
  error: string | null
}

/** Local consent only; never a wallet or business proof. Samples stay in memory. */
export function canConfirmProofReview(
  snapshot: ProofReviewSnapshot,
  now = Date.now(),
): boolean {
  const { account } = snapshot
  return (
    snapshot.expiresAt > now &&
    snapshot.canConfirm &&
    !snapshot.error &&
    snapshot.responseState === 'json' &&
    account.status === 'matched' &&
    typeof account.expected === 'string' &&
    /^0x[\da-f]{40}$/i.test(account.expected) &&
    !/^0x0{40}$/i.test(account.expected) &&
    typeof account.observed === 'string' &&
    account.expected.toLowerCase() === account.observed.toLowerCase()
  )
}

export class ProofReviewGate {
  private pending: {
    snapshot: ProofReviewSnapshot
    settle(accepted: boolean): void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private now = Date.now,
    private changed: () => void = () => {},
  ) {}

  snapshot(): ProofReviewSnapshot | null {
    if (this.pending && this.pending.snapshot.expiresAt <= this.now())
      this.cancel()
    return this.pending ? structuredClone(this.pending.snapshot) : null
  }

  wait(snapshot: ProofReviewSnapshot): Promise<boolean> {
    this.cancel()
    if (snapshot.expiresAt <= this.now()) return Promise.resolve(false)
    return new Promise((settle) => {
      this.pending = {
        snapshot: structuredClone(snapshot),
        settle,
        timer: setTimeout(() => this.cancel(), snapshot.expiresAt - this.now()),
      }
      this.changed()
    })
  }

  confirm(id: string): boolean {
    const snapshot = this.snapshot()
    if (
      !snapshot ||
      snapshot.id !== id ||
      !canConfirmProofReview(snapshot, this.now())
    )
      return false
    this.finish(true)
    return true
  }

  cancel(): void {
    this.finish(false)
  }

  private finish(accepted: boolean): void {
    const pending = this.pending
    if (!pending) return
    this.pending = null
    clearTimeout(pending.timer)
    pending.settle(accepted)
    this.changed()
  }
}
