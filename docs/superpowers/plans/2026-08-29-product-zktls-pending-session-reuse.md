# Product zkTLS Pending Session Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Retry Proof resume the backend's existing unexpired zkTLS proof session instead of requesting a duplicate session.

**Architecture:** Keep the existing queue item as the sole durable state. A small validator converts complete, future-dated queue metadata into the existing `ProductZkTlsSession` shape. The queue reuses that value before calling `startZkTls`; only start failures, expired sessions, and malformed metadata clear it.

**Tech Stack:** TypeScript, Vitest, Chrome extension session storage

---

### Task 1: Lock the retry and recovery behavior with failing tests

**Files:**
- Modify: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Change the failed-proof retry test to require session reuse**

Replace the existing `retries cleared failed work only after a later trigger`
expectations with a test that keeps the first backend session and proves twice:

```ts
it('reuses an unexpired backend session when a later trigger retries a failed proof', async () => {
  harness.startZkTls.mockResolvedValueOnce({
    sessionId: 'failed-session',
    connectorId: 'failed-connector',
    expiresAt: '2026-07-13T10:10:00.000Z',
  })
  harness.proveZkTls
    .mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'error',
      code: 'REQUEST_NOT_CAPTURED',
    }))
    .mockImplementationOnce(async (input) => ({
      type: 'zktls-prove-result',
      correlationId: input.correlationId,
      status: 'submitted',
    }))

  await harness.controller.handleEvidence(sender(), 'session-12345678', [
    match('rule-a'),
  ])
  await vi.waitFor(() =>
    expect(harness.storage.session?.zkTlsQueue[0]).toEqual({
      ruleId: 'rule-a',
      status: 'queued',
      sessionId: 'failed-session',
      connectorId: 'failed-connector',
      expiresAt: '2026-07-13T10:10:00.000Z',
    }),
  )

  await harness.controller.handleEvidence(sender(), 'session-12345678', [
    match('rule-a'),
  ])
  await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))

  expect(harness.startZkTls).toHaveBeenCalledTimes(1)
  expect(harness.proveZkTls).toHaveBeenNthCalledWith(
    2,
    expect.objectContaining({
      sessionId: 'failed-session',
      connectorId: 'failed-connector',
      expiresAt: '2026-07-13T10:10:00.000Z',
    }),
  )
})
```

- [ ] **Step 2: Add thrown-prover and worker-recovery coverage**

Use the same session fixture in two tests. In the first, make
`proveZkTls.mockRejectedValueOnce(new Error('prover failed'))`, trigger the
same rule again, and assert one start call and two prover calls. In the second,
store a queue item with `status: 'proving'`, then construct a new controller and
call `resumePendingSubmit()`.

```ts
expect(harness.startZkTls).not.toHaveBeenCalled()
await expect(restarted.resumePendingSubmit()).resolves.toMatchObject({
  status: 'submitting',
})
expect(harness.proveZkTls).toHaveBeenCalledWith(
  expect.objectContaining({
    sessionId: 'interrupted-session',
    connectorId: 'interrupted-connector',
  }),
)
```

- [ ] **Step 3: Add stale and malformed metadata coverage**

Use `it.each` with an expired timestamp, invalid timestamp, and missing
connector ID. Store each input as a queued item, call `resumePendingSubmit()`,
and assert that the controller starts and proves a fresh session:

```ts
it.each([
  ['expired', 'old-session', 'old-connector', '2026-07-13T09:59:59.000Z'],
  ['invalid expiry', 'old-session', 'old-connector', 'not-a-date'],
  ['missing connector', 'old-session', null, '2026-07-13T10:10:00.000Z'],
] as const)(
  'starts a fresh session for %s metadata',
  async (_label, sessionId, connectorId, expiresAt) => {
    const session = await harness.storage.getSession()
    if (!session) throw new Error('missing session')
    session.zkTlsQueue = [{
      ruleId: 'rule-a',
      status: 'proving',
      sessionId,
      connectorId,
      expiresAt,
    }]
    await harness.storage.setSession(session)

    const restarted = new ProductExperienceController(harness.dependencies)
    await restarted.resumePendingSubmit()

    await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))
    expect(harness.startZkTls).toHaveBeenCalledTimes(1)
    expect(harness.proveZkTls).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: 'zktls-session-1' }),
    )
  },
)
```

The decisive assertions are:

```ts
expect(harness.startZkTls).toHaveBeenCalledTimes(1)
expect(harness.proveZkTls).toHaveBeenCalledWith(
  expect.objectContaining({ sessionId: 'zktls-session-1' }),
)
```

- [ ] **Step 4: Preserve explicit expiry behavior**

Configure `proveZkTls` to return `code: 'SESSION_EXPIRED'`, then assert the
exact cleared queue value:

```ts
expect(harness.storage.session?.zkTlsQueue[0]).toEqual({
  ruleId: 'rule-a',
  status: 'queued',
  sessionId: null,
  connectorId: null,
  expiresAt: null,
})
```

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-controller.test.ts
```

Expected: the new reuse and recovery assertions fail because the current
controller clears the session metadata and calls `startZkTls` again. Existing
unrelated tests remain green.

### Task 2: Reuse valid queue metadata in the controller

**Files:**
- Modify: `src/lib/product-experience-controller.ts`
- Test: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Add one private conversion helper**

Add a small pure helper near `isExpired`:

```ts
function reusableZkTlsSession(
  item: ProductZkTlsQueueItem,
  now: number,
): ProductZkTlsSession | null {
  if (!item.sessionId || !item.connectorId || !item.expiresAt) return null
  const expiresAt = Date.parse(item.expiresAt)
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null
  return {
    sessionId: item.sessionId,
    connectorId: item.connectorId,
    expiresAt: item.expiresAt,
  }
}
```

- [ ] **Step 2: Preserve valid metadata when resetting a prover attempt**

Extend `resetZkTlsItem` with a `clearSession` flag that defaults to `true`.
Clear the three fields only when that flag is true:

```ts
private async resetZkTlsItem(
  sessionId: string,
  ruleId: string,
  error: ProductExperiencePublicError = 'VERIFICATION_FAILED',
  clearSession = true,
): Promise<void> {
  const reset = await this.mutateZkTlsSession(sessionId, (current) => {
    const item = current.zkTlsQueue.find((entry) => entry.ruleId === ruleId)
    if (!item) return
    const authorizationRequired =
      current.status === 'reauthorize' ||
      !current.currentOriginAllowed ||
      current.error === 'AUTHORIZATION_REQUIRED'
    item.status = 'queued'
    if (clearSession) {
      item.sessionId = null
      item.connectorId = null
      item.expiresAt = null
    }
    current.status =
      authorizationRequired || error === 'AUTHORIZATION_REQUIRED'
        ? 'reauthorize'
        : 'observing'
    current.error = authorizationRequired ? 'AUTHORIZATION_REQUIRED' : error
  })
  if (reset) await this.notify()
}
```

Keep `clearSession=true` for failed starts and `SESSION_EXPIRED`. Pass
`clearSession=false` for thrown prover errors and other prover error results.

- [ ] **Step 3: Reuse metadata before starting a new backend session**

After normalizing an interrupted `proving` item to `queued`, derive `started`
from the latest stored queue item. Call `startZkTls` only when the helper
returns `null`:

```ts
const current = await this.dependencies.storage.getSession()
if (!isZkTlsSession(current)) return
const queued = current.zkTlsQueue.find(
  (entry) => entry.ruleId === item.ruleId && entry.status === 'queued',
)
if (!queued) return

let started = reusableZkTlsSession(queued, this.dependencies.now())
if (!started) {
  try {
    started = await this.dependencies.startZkTls({
      campaignId: current.campaignId,
      ruleId: queued.ruleId,
      ticketKind: current.ticketKind,
    })
  } catch {
    this.zkTlsDrainRequested = false
    await this.resetZkTlsItem(current.sessionId, queued.ruleId)
    this.zkTlsDrainRequested = false
    return
  }
}
```

When metadata is partial or stale, the existing mutation that records
`started` overwrites all three fields with the fresh backend result.

- [ ] **Step 4: Preserve valid metadata during worker recovery**

In `resumePendingSubmit` and the defensive `status === 'proving'` branch, set
only `status = 'queued'`. Clear the three fields only if
`reusableZkTlsSession(item, this.dependencies.now())` returns `null`.

- [ ] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-controller.test.ts
```

Expected: the entire file passes, including reuse, expiry, malformed metadata,
no implicit retry, submitted polling, `PARTIAL`, and `VERIFIED` cases.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/lib/product-experience-controller.ts \
  src/lib/__tests__/product-experience-controller.test.ts
git commit -m "fix(extension): reuse pending zkTLS proof sessions"
```

### Task 3: Run regression and build gates

**Files:**
- Verify only; no planned code changes

- [ ] **Step 1: Run related Product Experience suites**

```bash
pnpm exec vitest run \
  src/lib/__tests__/product-experience-controller.test.ts \
  src/entrypoints/popup/__tests__/product-experience-card.test.tsx \
  src/entrypoints/background/__tests__/product-experience-watcher.test.ts
```

Expected: all suites and tests pass.

- [ ] **Step 2: Run the full extension gates**

```bash
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/product-experience-controller.ts \
  src/lib/__tests__/product-experience-controller.test.ts
pnpm run build
git diff --check
```

Expected: all commands exit zero. The build may print only the repository's
existing Vite or WXT deprecation warnings.

- [ ] **Step 3: Confirm repository state**

```bash
git status --short --branch
```

Expected: no uncommitted files and the feature branch is ahead by the design,
plan, and implementation commits.

- [ ] **Step 4: Hand off the browser retest**

Rebuild and reload `.output/chrome-mv3`, revisit the authorized trigger page,
and click Retry Proof. Confirm the backend receives no second start request for
the pending rule and that the popup advances to proving, submitted, partial, or
verified instead of returning `PRODUCT_ZKTLS_PROOF_PENDING`.
