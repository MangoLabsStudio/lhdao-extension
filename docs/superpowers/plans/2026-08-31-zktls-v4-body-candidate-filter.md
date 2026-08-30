# zkTLS V4 Body Candidate Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ignore unrelated, well-formed POST bodies on a signed V4 endpoint and capture the later exact request.

**Architecture:** Reuse the existing strict `matchV4Body` matcher before `CaptureSession` claims a POST candidate. A `null` match returns without state changes; parser errors remain terminal. The existing header-stage match is retained as defense in depth.

**Tech Stack:** TypeScript, Chrome MV3 `webRequest`, Vitest, Biome, WXT

---

### Task 1: Reproduce the Multiplexed-Endpoint Race

**Files:**
- Modify: `src/lib/__tests__/zktls-capture.test.ts`

- [ ] **Step 1: Add the failing regression**

Add a V4 capture test that sends a well-formed same-path JSON body with a wrong
operation, verifies that no request is available, then sends the existing exact
body and verifies that it is captured.

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
occupied the candidate.

### Task 2: Filter Before Candidate Reservation

**Files:**
- Modify: `src/lib/zktls/capture.ts`

- [ ] **Step 1: Add the minimal prefilter**

In the V4 POST branch of `observeBody()`, join the raw body and call the existing
`matchV4Body` with the signed content type, template, resolved variables, and
BODY_JSON variable declarations. Return when it yields `null`. Do not catch
strict-parser errors.

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

- [ ] **Step 2: Build with the existing Beta environment**

Use the established Beta build command and verify the compiled GraphQL endpoint
is `https://service.lhdaobeta.top/graphql`. Do not use the production defaults.

- [ ] **Step 3: Re-run the live Nado proof**

Reload the unpacked extension, start a new proof, and trigger the signed Nado
operation during the capture window. Record the actual next stage; do not call
the E2E successful until Backend reports the proof result.

