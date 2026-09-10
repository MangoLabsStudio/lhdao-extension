import { ProofReviewGate, type ProofReviewSnapshot } from './review'
import type { ZkTlsRunRequest, ZkTlsRunResult } from './runtime'

export type ProofReviewUiState = {
  phase: 'preparing' | 'reading' | 'ready' | 'proving' | 'failed'
  snapshot: ProofReviewSnapshot | null
  error: string | null
}

/** Popup-only local review. Broadcasts a change signal, never samples. */
export class ProductProofReview {
  private gate: ProofReviewGate
  private active: {
    abort: AbortController
    reread: boolean
    phase: ProofReviewUiState['phase']
  } | null = null
  private failure: string | null = null
  private assertOwner: (() => Promise<void>) | null = null
  constructor(private changed: () => void) {
    this.gate = new ProofReviewGate(Date.now, changed)
  }
  isPopup(sender: chrome.runtime.MessageSender): boolean {
    return (
      sender.id === chrome.runtime.id &&
      sender.tab === undefined &&
      sender.url === chrome.runtime.getURL('popup.html')
    )
  }
  state(): ProofReviewUiState | null {
    if (!this.active && !this.failure) return null
    return {
      phase: this.active?.phase ?? 'failed',
      snapshot: this.gate.snapshot(),
      error: this.failure,
    }
  }
  confirm(id: string): boolean {
    return this.gate.confirm(id)
  }
  async checkOwner(): Promise<void> {
    try {
      await this.assertOwner?.()
    } catch {
      this.cancel()
      this.failure = 'REVIEW_OWNER_CHANGED'
      this.changed()
    }
  }
  cancel(reread = false): void {
    if (this.active) {
      this.active.reread = reread
      this.active.abort.abort()
    }
    this.gate.cancel()
    this.failure = null
    this.changed()
  }
  async run(
    request: ZkTlsRunRequest,
    prove: (request: ZkTlsRunRequest) => Promise<ZkTlsRunResult>,
    assertOwner: () => Promise<void>,
  ): Promise<ZkTlsRunResult> {
    if (!request.reviewContext) return prove(request)
    if (this.active)
      return {
        type: 'zktls-prove-result',
        correlationId: request.correlationId,
        status: 'error',
        code: 'ZKTLS_BUSY',
      }
    await assertOwner()
    const active = {
      abort: new AbortController(),
      reread: false,
      phase: 'preparing' as ProofReviewUiState['phase'],
    }
    this.active = active
    this.assertOwner = assertOwner
    this.failure = null
    this.changed()
    try {
      const result = await prove({
        ...request,
        review: {
          signal: active.abort.signal,
          onReady: () => {
            active.phase = 'reading'
            this.changed()
          },
          confirm: async (snapshot) => {
            await assertOwner()
            if (active.abort.signal.aborted) return false
            active.phase = 'ready'
            return this.gate.wait(snapshot)
          },
          assertOwner,
          onProving: () => {
            active.phase = 'proving'
            this.changed()
          },
        },
      })
      if (active.reread)
        return {
          ...result,
          status: 'action_required',
          code: 'REVIEW_READ_AGAIN',
        }
      if (result.status !== 'submitted')
        this.failure = `${result.code ?? 'PROVER_FAILED'}${result.message && result.message !== result.code ? `: ${result.message}` : ''}`
      return result
    } finally {
      this.gate.cancel()
      if (this.active === active) this.active = null
      this.assertOwner = null
      this.changed()
    }
  }
}
