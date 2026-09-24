# zkTLS V4 Ambient Cookie Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an exact credential-free V4 page request trigger capture when the browser adds an ambient Cookie, without reading or replaying that Cookie.

**Architecture:** Keep the signed request and public-header contracts unchanged. Add one trigger-only Cookie exception to the V4 header-name decision; the existing V4 capture result continues to omit all secrets and the proof request continues to be built from signed data.

**Tech Stack:** TypeScript, Chrome MV3 `webRequest`, Vitest, Biome, WXT

---

### Task 1: Lock the Cookie Boundary with a Failing Test

**Files:**
- Modify: `src/lib/__tests__/zktls-capture.test.ts:923-970`

- [ ] **Step 1: Add an ambient Cookie success test**

Create a V4 POST candidate, attach a Cookie header whose value is an accessor,
and assert that capture succeeds without invoking the accessor:

```ts
test('ignores an ambient V4 Cookie without reading or capturing its value', () => {
  const capture = v4Session()
  capture.observeBody({
    requestId: 'ambient-cookie',
    tabId: 7,
    frameId: 0,
    method: 'POST',
    url,
    type: 'fetch',
    initiator: 'https://app.example.com',
    requestBody: {
      raw: chunks.map((chunk) => ({ bytes: chunk.buffer })),
    },
  })
  let valueReads = 0
  const cookie = { name: 'Cookie' } as { name: string; value?: string }
  Object.defineProperty(cookie, 'value', {
    get() {
      valueReads += 1
      return 'private'
    },
  })
  capture.observe({
    requestId: 'ambient-cookie',
    tabId: 7,
    frameId: 0,
    method: 'POST',
    url,
    type: 'fetch',
    initiator: 'https://app.example.com',
    requestHeaders: [
      { name: 'Content-Type', value: 'application/json' },
      cookie,
    ],
  })
  expect(valueReads).toBe(0)
  expect(capture.take()).toMatchObject({
    method: 'POST',
    body,
    secrets: {},
  })
})
```

Remove Cookie from the existing forbidden-header table. Keep every other
credential and custom header rejection in that table.

- [ ] **Step 2: Run the focused suite and confirm RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts
```

Expected: the new test fails with `no provider request was captured`; the
Cookie accessor count remains zero.

### Task 2: Ignore Only the Ambient Cookie Name

**Files:**
- Modify: `src/lib/zktls/capture.ts:396-402`
- Test: `src/lib/__tests__/zktls-capture.test.ts`

- [ ] **Step 1: Add the minimal V4 trigger-only exception**

Change the header predicate without adding Cookie to the signed public-header
set:

```ts
function v4PublicHeader(name: string, binding: V4CaptureBinding): boolean {
  const normalized = name.toLowerCase()
  return (
    normalized === 'cookie' ||
    V4_PUBLIC_HEADER_NAMES.has(normalized) ||
    Object.hasOwn(binding.publicHeaders ?? {}, normalized)
  )
}
```

This branch reads only `header.name`. Do not read `header.value`, create a
Cookie field on `CapturedRequest`, or change request replay construction.

- [ ] **Step 2: Run the focused suite and confirm GREEN**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts
```

Expected: all capture tests pass. Cookie succeeds with zero value reads; all
other credential and custom headers still discard the candidate.

- [ ] **Step 3: Commit the behavior**

```bash
git add src/lib/zktls/capture.ts src/lib/__tests__/zktls-capture.test.ts
git commit -m "fix(zktls): ignore ambient V4 cookies"
```

### Task 3: Verify and Build the Beta Extension

**Files:**
- Verify: `src/lib/zktls/capture.ts`
- Verify: `src/lib/__tests__/zktls-capture.test.ts`
- Generated and untracked: `.output/chrome-mv3/`

- [ ] **Step 1: Run automated gates**

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts src/lib/__tests__/zktls-runtime.test.ts
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/zktls/capture.ts src/lib/__tests__/zktls-capture.test.ts
git diff --check HEAD^ HEAD
```

Expected: every command exits zero.

- [ ] **Step 2: Build with explicit Beta endpoints**

Use `https://app.lhdaobeta.top` and
`https://service.lhdaobeta.top` for the web, GraphQL, and signed-config
endpoints. Supply the deployed Beta Verifier endpoint, public keys, and profile
through the existing WXT environment variables, then run:

```bash
pnpm run build
```

Expected: WXT creates `.output/chrome-mv3/`.

- [ ] **Step 3: Verify the artifact and perform browser E2E**

Search the built JavaScript for both Beta hosts and assert that production API
hosts are absent. Reload `.output/chrome-mv3/` in Chrome, create a fresh Beta
proof attempt, open the authorized Nado history page, and trigger a fresh
Deposits request. Confirm capture advances past `ZKTLS_CAPTURE_FAILED` into the
Verifier/proof stages.
