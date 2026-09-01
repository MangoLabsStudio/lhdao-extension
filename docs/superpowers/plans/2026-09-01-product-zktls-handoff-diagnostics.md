# Product zkTLS Handoff Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the exact handoff failure between a matched page rule and zkTLS capture.

**Architecture:** Reuse the existing bounded diagnostic stream. The content script reports evidence delivery, and the controller reports evidence acceptance plus signed-session startup. Existing sanitization, queueing, retry, and popup rendering remain unchanged.

**Tech Stack:** TypeScript, WXT/Chrome runtime messaging, Vitest

---

### Task 1: Report evidence delivery

**Files:**
- Modify: `src/lib/product-experience-watcher.ts`
- Modify: `src/entrypoints/product-experience.content.ts`
- Modify: `src/lib/product-experience-controller.ts`
- Test: `src/lib/__tests__/product-experience-watcher.test.ts`
- Test: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Write failing delivery tests**

Add tests that call a small exported evidence dispatcher with an injected
`sendMessage`. Assert a successful evidence acknowledgement is followed by an
`evidence-sent` passed diagnostic. Assert a rejected evidence message attempts
an `evidence-sent` failed diagnostic containing the original `Error`, then
rejects so the watcher lifecycle can stop. Add a controller test proving the
current tab accepts the new page diagnostic stage.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-watcher.test.ts src/lib/__tests__/product-experience-controller.test.ts
```

Expected: FAIL because the evidence dispatcher does not exist and the
controller ignores `evidence-sent`.

- [ ] **Step 3: Implement the minimum dispatcher**

Add one helper beside `createProductExperienceEvidenceMessage`:

```ts
export async function dispatchProductExperienceEvidence(input: {
  sessionId: string
  matches: readonly ProductRuleMatch[]
  now: () => number
  sendMessage: (message: unknown) => Promise<unknown>
}): Promise<void> {
  try {
    await input.sendMessage(
      createProductExperienceEvidenceMessage(input.sessionId, input.matches),
    )
  } catch (error) {
    await input
      .sendMessage({
        type: 'product-experience-diagnostic',
        sessionId: input.sessionId,
        event: {
          at: input.now(),
          stage: 'evidence-sent',
          status: 'failed',
          error,
        },
      })
      .catch(() => undefined)
    throw error
  }
  await input
    .sendMessage({
      type: 'product-experience-diagnostic',
      sessionId: input.sessionId,
      event: {
        at: input.now(),
        stage: 'evidence-sent',
        status: 'passed',
      },
    })
    .catch(() => undefined)
}
```

Use it in the content script and keep the existing lifecycle stop on rejection.
Allow only `rule-evaluated` and `evidence-sent` through the page diagnostic
handler.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run the Step 2 command. Expected: both files pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/product-experience-watcher.ts src/entrypoints/product-experience.content.ts src/lib/product-experience-controller.ts src/lib/__tests__/product-experience-watcher.test.ts src/lib/__tests__/product-experience-controller.test.ts
git commit -m "fix(zktls): report evidence delivery"
```

### Task 2: Report controller handoff and signed-session failure

**Files:**
- Modify: `src/lib/product-experience-controller.ts`
- Test: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Write failing controller tests**

Add one successful queue test asserting this order:

```ts
expect(stages).toEqual(
  expect.arrayContaining(['evidence-accepted', 'proof-session-requested']),
)
```

Add one failure test where `startZkTls` rejects with an `Error` carrying code
`SESSION_START_FAILED`. Assert the durable diagnostic ends with:

```ts
expect.objectContaining({
  stage: 'proof-session-failed',
  status: 'failed',
  error: expect.objectContaining({
    name: 'Error',
    message: 'session bootstrap unavailable',
    code: 'SESSION_START_FAILED',
  }),
})
```

Also assert the existing public state remains retryable and contains no ticket,
mac key, cookie, authorization value, or token.

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/product-experience-controller.test.ts
```

Expected: FAIL because the controller does not append these stages.

- [ ] **Step 3: Append the controller diagnostics**

Inside the existing evidence mutation, append `evidence-accepted` after
validation and before queue draining. Before `startZkTls`, append and persist
`proof-session-requested`. On rejection, pass a `proof-session-failed` event to
the existing item reset mutation so the error and retryable state are written
atomically.

Do not change the GraphQL request, proof input, queue selection, retry policy,
or failure code mapping.

- [ ] **Step 4: Run the controller test and verify GREEN**

Run the Step 2 command. Expected: all controller tests pass.

- [ ] **Step 5: Run final gates**

```bash
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/product-experience-watcher.ts src/entrypoints/product-experience.content.ts src/lib/product-experience-controller.ts src/lib/__tests__/product-experience-watcher.test.ts src/lib/__tests__/product-experience-controller.test.ts
git diff --check
```

Expected: all commands exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/product-experience-controller.ts src/lib/__tests__/product-experience-controller.test.ts
git commit -m "fix(zktls): expose proof session startup failures"
```
