# Product zkTLS Session Queue MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent an old Product zkTLS queue flight from silently blocking a new session, while keeping proofs serial within one session.

**Architecture:** Replace the controller-wide Promise and drain boolean with one session-owned flight record. Scope each queue loop and mutation to its session ID. Let same-session evidence request a new pass, expose `proof-queue-waiting`, and yield a submitted-rule poll before it consumes its full retry budget.

**Tech Stack:** TypeScript, React-free controller logic, Vitest, Chrome MV3/WXT.

---

### Task 1: Reproduce stale-session and same-session queue blocking

**Files:**
- Modify: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Expose deterministic session IDs in the test harness**

Replace the inline `randomSessionId` dependency with a mock that tests can
reconfigure:

```ts
const randomSessionId = vi.fn(() => 'session-12345678')
const dependencies: ProductExperienceControllerDependencies = {
  // existing dependencies
  randomSessionId,
}

return {
  // existing harness fields
  randomSessionId,
}
```

- [ ] **Step 2: Add a failing stale-session regression**

Add this test beside the existing queue-serialization tests:

```ts
it('does not let an unresolved old-session flight block a replacement session', async () => {
  await harness.controller.cancel()
  harness = createHarness()
  harness.randomSessionId
    .mockReturnValueOnce('old-session')
    .mockReturnValueOnce('new-session')
  harness.mintParticipant.mockResolvedValue(
    ticket({ verificationMode: 'ZKTLS' }),
  )
  harness.mintTest.mockResolvedValue(ticket({ verificationMode: 'ZKTLS' }))

  let finishOld: ((value: Awaited<ReturnType<typeof harness.proveZkTls>>) => void)
    | undefined
  harness.proveZkTls.mockImplementationOnce(
    (input) =>
      new Promise((resolve) => {
        finishOld = resolve
      }),
  )

  await harness.controller.saveTask(task())
  await harness.controller.start()
  await harness.controller.handleEvidence(sender(), 'old-session', [
    match('rule-a'),
  ])
  await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(1))

  await harness.controller.saveTask(replacementTask())
  await harness.controller.start()
  await harness.controller.handleEvidence(sender(), 'new-session', [
    match('rule-a'),
  ])

  await vi.waitFor(() => expect(harness.startZkTls).toHaveBeenCalledTimes(2))
  expect(harness.storage.session?.sessionId).toBe('new-session')

  finishOld?.({
    type: 'zktls-prove-result',
    correlationId: 'old-correlation',
    status: 'error',
    code: 'REQUEST_NOT_CAPTURED',
  })
  await flushAsync()
  expect(harness.storage.session?.sessionId).toBe('new-session')
})
```

- [ ] **Step 3: Add a failing same-session yield regression**

```ts
it('shows queue waiting and yields an older submitted poll to new work', async () => {
  await harness.controller.cancel()
  harness = createHarness(true)
  harness.mintParticipant.mockResolvedValue(
    ticket({ verificationMode: 'ZKTLS' }),
  )
  harness.startZkTls
    .mockResolvedValueOnce({
      sessionId: 'first-proof',
      connectorId: 'first-connector',
      expiresAt: '2026-07-13T10:10:00.000Z',
    })
    .mockResolvedValueOnce({
      sessionId: 'second-proof',
      connectorId: 'second-connector',
      expiresAt: '2026-07-13T10:10:00.000Z',
    })
  await harness.controller.saveTask(task())
  await harness.controller.start()

  await harness.controller.handleEvidence(sender(), 'session-12345678', [
    match('rule-a'),
  ])
  await vi.waitFor(() =>
    expect(harness.storage.session?.zkTlsQueue[0]?.status).toBe('submitted'),
  )

  await harness.controller.handleEvidence(sender(), 'session-12345678', [
    match('rule-b'),
  ])
  expect(
    harness.storage.session?.zkTlsDiagnostic?.events.map((event) => event.stage),
  ).toContain('proof-queue-waiting')

  await vi.advanceTimersByTimeAsync(1_000)
  await flushAsync()
  await vi.waitFor(() => expect(harness.proveZkTls).toHaveBeenCalledTimes(2))
  expect(harness.proveZkTls).toHaveBeenLastCalledWith(
    expect.objectContaining({ sessionId: 'second-proof' }),
  )
})
```

- [ ] **Step 4: Run the tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-controller.test.ts
```

Expected: the stale-session test times out waiting for the second
`startZkTls`, and the same-session test cannot find `proof-queue-waiting` or a
second prover call after one second.

### Task 2: Make the controller queue session-owned

**Files:**
- Modify: `src/lib/product-experience-controller.ts`
- Test: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Add the minimal flight type**

Place this type beside the existing submit-flight type:

```ts
interface ProductExperienceZkTlsFlight {
  sessionId: string
  drainRequested: boolean
  promise: Promise<void>
}
```

Replace the two global fields:

```ts
private zkTlsFlight: ProductExperienceZkTlsFlight | null = null
```

Delete `private zkTlsDrainRequested = false`.

- [ ] **Step 2: Pass the owning session ID at every drain call**

Update all controller call sites to use their stored session ID:

```ts
void this.drainZkTlsQueue(existing.sessionId)
void this.drainZkTlsQueueAfterCurrentFlight(existing.sessionId)
void this.drainZkTlsQueue(session.sessionId)
void this.drainZkTlsQueue(resumed.sessionId)
void this.drainZkTlsQueue(queued.sessionId, true)
```

Update the helper signatures:

```ts
private async drainZkTlsQueueAfterCurrentFlight(sessionId: string): Promise<void>
private drainZkTlsQueue(
  sessionId: string,
  hasNewQueuedWork = false,
): Promise<void>
private async runZkTlsQueue(
  sessionId: string,
  flight: ProductExperienceZkTlsFlight,
): Promise<void>
```

- [ ] **Step 3: Implement session-owned flight replacement**

Use one mutable record so its cleanup compares object identity:

```ts
private drainZkTlsQueue(
  sessionId: string,
  hasNewQueuedWork = false,
): Promise<void> {
  const active = this.zkTlsFlight
  if (active?.sessionId === sessionId) {
    if (hasNewQueuedWork) active.drainRequested = true
    return active.promise
  }

  const flight: ProductExperienceZkTlsFlight = {
    sessionId,
    drainRequested: false,
    promise: Promise.resolve(),
  }
  flight.promise = this.runZkTlsQueue(sessionId, flight).finally(() => {
    if (this.zkTlsFlight !== flight) return
    this.zkTlsFlight = null
    if (flight.drainRequested) void this.drainZkTlsQueue(sessionId)
  })
  this.zkTlsFlight = flight
  return flight.promise
}
```

`drainZkTlsQueueAfterCurrentFlight` waits only for the same session:

```ts
const active = this.zkTlsFlight
if (active?.sessionId === sessionId) await active.promise
await this.drainZkTlsQueue(sessionId)
```

- [ ] **Step 4: Scope the loop and prioritize new queued work**

At the start of each loop, reject another stored session:

```ts
const session = await this.dependencies.storage.getSession()
if (!isZkTlsSession(session) || session.sessionId !== sessionId) return
```

Select queued or interrupted proving work before a submitted poll:

```ts
const item =
  session.zkTlsQueue.find((entry) => entry.status !== 'submitted') ??
  session.zkTlsQueue.find(
    (entry) =>
      !this.exhaustedZkTlsPolls.has(
        this.zkTlsPollKey(session.sessionId, entry.ruleId),
      ),
  )
```

Pass `flight` into `pollZkTlsProgress`. After each delay and before the backend
progress request, yield when new queued work arrived:

```ts
if (flight.drainRequested) {
  this.exhaustedZkTlsPolls.add(pollKey)
  return false
}
```

Do not clear `flight.drainRequested` inside the queue loop. The flight cleanup
consumes it and starts the next pass.

- [ ] **Step 5: Record the waiting diagnostic with accepted evidence**

Inside the existing `mutateZkTlsSession` callback in `processEvidence`, append
the waiting event only when a same-session flight already exists:

```ts
if (this.zkTlsFlight?.sessionId === current.sessionId) {
  this.appendZkTlsDiagnostic(current, {
    at: this.dependencies.now(),
    stage: 'proof-queue-waiting',
    status: 'running',
    details: { ruleIds: sanitized.map((match) => match.ruleId) },
  })
}
```

The existing diagnostic helper already no-ops when diagnostics are disabled.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-controller.test.ts
```

Expected: all controller tests pass. The new tests prove that session B starts
before session A settles and that same-session rule B starts after the next
one-second poll boundary.

- [ ] **Step 7: Commit the queue fix**

```bash
git add src/lib/product-experience-controller.ts \
  src/lib/__tests__/product-experience-controller.test.ts
git commit -m "fix(zktls): isolate product proof queues by session"
```

### Task 3: Run full extension and Beta gates

**Files:**
- Verify: `src/lib/product-experience-controller.ts`
- Verify: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Run the full test suite**

```bash
pnpm test
```

Expected: all test files pass with zero failures.

- [ ] **Step 2: Run static checks**

```bash
pnpm run typecheck
pnpm exec biome check \
  src/lib/product-experience-controller.ts \
  src/lib/__tests__/product-experience-controller.test.ts
git diff --check HEAD~2..HEAD
```

Expected: every command exits 0 with no fixes applied.

- [ ] **Step 3: Build the unpacked Beta extension**

Use the verified Beta endpoints and public signing key already used by this
worktree:

```bash
WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
WXT_WEB_ENDPOINT=https://app.lhdaobeta.top \
WXT_ZKTLS_ENABLED=true \
WXT_ZKTLS_DEBUG=true \
WXT_ZKTLS_API_ENDPOINT=https://service.lhdaobeta.top/zktls/signed-config \
WXT_ZKTLS_VERIFIER_ENDPOINT=wss://lighthouse-zktls-verifier-v4-production.up.railway.app/session \
WXT_ZKTLS_VERIFIER_PROFILE_ID=lighthouse-beta-v1 \
WXT_ZKTLS_PUBLIC_KEYS='{"zktls-beta-20260817":{"kty":"OKP","crv":"Ed25519","x":"FGcIQf0eKTr6JwUkI_uXsF_uAeE3jgzzUz2R4bPytE8"}}' \
pnpm run build
```

Expected: WXT builds Chrome MV3 at `.output/chrome-mv3`.

- [ ] **Step 4: Verify the artifact and repository state**

Confirm the generated text contains the Beta API, Beta web origin,
`proof-queue-waiting`, and `proof-session-requested`; confirm it does not
contain the production GraphQL endpoint. Then run:

```bash
git status --porcelain=v1
git diff --check
```

Expected: the worktree is clean and the diff check exits 0.
