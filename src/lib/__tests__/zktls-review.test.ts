import { describe, expect, test, vi } from 'vitest'
import { ProofReviewGate, type ProofReviewSnapshot } from '../zktls/review'

const preview = (): ProofReviewSnapshot => ({
  id: 'review-1',
  connectorId: 'binding',
  title: '账号绑定',
  pageOrigin: 'https://app.example.com',
  pagePath: '/history',
  targetOrigin: 'https://api.example.com',
  requestPath: '/v1',
  method: 'POST',
  capturedAt: 1000,
  expiresAt: 5000,
  account: {
    source: 'response',
    observed: '0x1111111111111111111111111111111111111111',
    expected: '0x1111111111111111111111111111111111111111',
    status: 'matched',
  },
  requestAccounts: [],
  request: { body: { query: 'history' } },
  response: { events: [] },
  responseState: 'json',
  values: [],
  canConfirm: true,
  error: null,
})

describe('proof review consent', () => {
  test('does not release proof until the matching preview is confirmed once', async () => {
    const gate = new ProofReviewGate(() => 1000)
    const proof = vi.fn()
    const pending = gate.wait(preview()).then((accepted) => {
      if (accepted) proof()
    })
    await Promise.resolve()
    expect(proof).not.toHaveBeenCalled()
    expect(gate.confirm('stale')).toBe(false)
    expect(gate.confirm('review-1')).toBe(true)
    expect(gate.confirm('review-1')).toBe(false)
    await pending
    expect(proof).toHaveBeenCalledTimes(1)
  })

  test.each([
    'mismatch',
    'unknown',
  ] as const)('blocks %s wallet even if UI claims ready', async (status) => {
    const gate = new ProofReviewGate(() => 1000)
    const snapshot = preview()
    snapshot.account.status = status
    const pending = gate.wait(snapshot)
    expect(gate.confirm(snapshot.id)).toBe(false)
    gate.cancel()
    await expect(pending).resolves.toBe(false)
  })

  test('cancels and expires consent without retaining the sample', async () => {
    let now = 1000
    const gate = new ProofReviewGate(() => now)
    const pending = gate.wait(preview())
    now = 5001
    expect(gate.confirm('review-1')).toBe(false)
    await expect(pending).resolves.toBe(false)
    expect(gate.snapshot()).toBeNull()
    const next = gate.wait({ ...preview(), id: 'next', expiresAt: 10000 })
    gate.cancel()
    await expect(next).resolves.toBe(false)
    expect(gate.confirm('next')).toBe(false)
  })
})
