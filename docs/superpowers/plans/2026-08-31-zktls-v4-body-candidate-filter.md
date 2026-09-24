# zkTLS V4 Body Candidate Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ignore unrelated, well-formed POST bodies on a signed V4 endpoint and capture the later exact request.

**Architecture:** Reuse the existing strict request and body matchers before `CaptureSession` claims a candidate. A mismatch or candidate parse error returns without state changes; the existing header-stage match remains the strict completion boundary. Merge current `origin/dev` before producing the Beta build.

**Tech Stack:** TypeScript, Chrome MV3 `webRequest`, Vitest, Biome, WXT

---

### Task 1: Reproduce the Multiplexed-Endpoint Race

**Files:**
- Modify: `src/lib/__tests__/zktls-capture.test.ts`

- [ ] **Step 1: Add the failing regression**

Add V4 capture tests that send same-path bodies which are well-formed but
mismatched, invalid JSON, oversized, or contain an invalid captured variable.
Each test then sends the existing exact body and verifies that it is captured.

```ts
test('ignores a mismatched V4 body and captures a later exact request', () => {
  const capture = v4Session()
  const unrelated = new TextEncoder().encode(
    '{"operation":"background","input":{"account":"acct-body","day":"2026-08-21"}}',
  )
  capture.observeBody({
    requestId: 'unrelated-body',
    tabId: 7,
    frameId: 0,
    method: 'POST',
    url,
    type: 'fetch',
    initiator: 'https://app.example.com',
    requestBody: { raw: [{ bytes: unrelated.buffer }] },
  })
  expect(() => capture.take()).toThrow('no provider request was captured')

  observePost(capture, 'exact-body')
  expect(capture.take()).toMatchObject({
    body: '{"operation":"account","input":{"account":"acct-body","day":"2026-08-21"}}',
  })
})
```

- [ ] **Step 2: Confirm RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts
```

Expected: the later exact request fails because the unrelated body already
occupied the candidate, or the malformed candidate ended the capture.

### Task 2: Filter Before Candidate Reservation

**Files:**
- Modify: `src/lib/zktls/capture.ts`

- [ ] **Step 1: Add the minimal prefilter**

In the V4 branch of `observeBody()`, treat request/body matcher exceptions as a
candidate mismatch before reservation. Return without mutating capture state.
Keep the existing strict matcher in `observe()` unchanged.

- [ ] **Step 2: Confirm GREEN**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts
```

Expected: the new regression and all existing capture tests pass.

### Task 3: Verify and Build the Beta Extension

**Files:**
- Verify: `src/lib/zktls/capture.ts`
- Verify: `src/lib/__tests__/zktls-capture.test.ts`
- Generated: `.output/chrome-mv3/`

- [ ] **Step 1: Run automated gates**

```bash
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/zktls/capture.ts src/lib/__tests__/zktls-capture.test.ts
git diff --check
```

- [ ] **Step 2: Merge current dev without force**

```bash
git fetch origin dev
git merge --no-edit origin/dev
```

Run the automated gates again after the merge.

- [ ] **Step 3: Build with the existing Beta environment**

Use the established Beta build command and verify the compiled GraphQL endpoint
is `https://service.lhdaobeta.top/graphql`. Do not use the production defaults.

- [ ] **Step 4: Re-run the live Nado proof**

Reload the unpacked extension, start a new proof, and trigger the signed Nado
operation during the capture window. Record the actual next stage; do not call
the E2E successful until Backend reports the proof result.
