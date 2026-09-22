# zkTLS V4 Unsafe Candidate Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a V4 capture session alive after a matching request carries a forbidden header, so a later safe request can complete the proof.

**Architecture:** Preserve the signed matcher and public-header allowlist. Add one private candidate-discard operation to `CaptureSession`; call it only when a V4 candidate contains an unsupported header name. The operation clears candidate-owned data and releases the request ID without setting the session's terminal failure.

**Tech Stack:** TypeScript, Chrome MV3 `webRequest`, Vitest, Biome, WXT

---

### Task 1: Lock the Recovery Contract with a Failing Test

**Files:**
- Modify: `src/lib/__tests__/zktls-capture.test.ts:921-1020`

- [ ] **Step 1: Replace the terminal-header expectation with a recovery test**

Use one representative credential header and one representative custom header.
Each forbidden header must expose a getter so the test proves that the extension
does not read its value.

```ts
test.each(['Cookie', 'X-App-Client-Type'])(
  'discards a V4 candidate with unsupported header %s and captures a later safe request',
  (name) => {
    const capture = v4Session()
    capture.observeBody({
      requestId: 'unsafe',
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
    const forbidden = { name } as { name: string; value?: string }
    Object.defineProperty(forbidden, 'value', {
      get() {
        valueReads += 1
        return 'private'
      },
    })

    expect(() =>
      capture.observe({
        requestId: 'unsafe',
        tabId: 7,
        frameId: 0,
        method: 'POST',
        url,
        type: 'fetch',
        initiator: 'https://app.example.com',
        requestHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          forbidden,
        ],
      }),
    ).not.toThrow()
    expect(valueReads).toBe(0)
    expect(() => capture.take()).toThrow('no provider request was captured')

    capture.observeBody({
      requestId: 'safe',
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
    capture.observe({
      requestId: 'safe',
      tabId: 7,
      frameId: 0,
      method: 'POST',
      url,
      type: 'fetch',
      initiator: 'https://app.example.com',
      requestHeaders: [
        { name: 'Content-Type', value: 'application/json' },
      ],
    })

    expect(capture.take()).toMatchObject({
      method: 'POST',
      path: provider.request.path,
      body,
      secrets: {},
    })
  },
)
```

Keep the existing missing/non-array-header tests unchanged. Retain a compact
table test for other forbidden names if it adds coverage without repeating the
full recovery flow; it must assert zero value reads and a non-terminal discard.

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts
```

Expected: the new test fails because `CaptureSession.observe()` throws
`captured request contains an unsupported header`, and the later request cannot
be captured.

### Task 2: Discard Only the Unsafe V4 Candidate

**Files:**
- Modify: `src/lib/zktls/capture.ts:779-821`
- Modify: `src/lib/zktls/capture.ts:1030-1050`

- [ ] **Step 1: Add a private candidate-discard operation**

Add this method next to `#fail`:

```ts
#discardCandidate(): void {
  if (this.#candidate) clearCapturedRequest(this.#candidate)
  this.#candidate = null
  this.#requestBody = undefined
  this.#requestId = null
}
```

It intentionally leaves `#failed`, `#captured`, `#redirected`, and `#used`
unchanged.

- [ ] **Step 2: Use the discard path only for unsupported V4 header names**

Replace the current unsupported-header `fail()` call with:

```ts
if (
  v4 &&
  details.requestHeaders!.some((header) => !v4PublicHeader(header.name))
) {
  this.#discardCandidate()
  return
}
```

Do not inspect `header.value` in this branch. Do not change
`V4_PUBLIC_HEADER_NAMES`, missing-header failure, content-type validation, or
legacy capture logic.

- [ ] **Step 3: Run the focused suite and confirm GREEN**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts
```

Expected: all tests pass, including recovery, zero-read, missing-header, and
V1/V3 regression cases.

- [ ] **Step 4: Commit the behavior and tests**

```bash
git add src/lib/zktls/capture.ts src/lib/__tests__/zktls-capture.test.ts
git commit -m "fix(zktls): skip unsafe V4 request candidates"
```

### Task 3: Verify the Extension and Build the Dev Artifact

**Files:**
- Verify: `src/lib/zktls/capture.ts`
- Verify: `src/lib/__tests__/zktls-capture.test.ts`
- Generated and untracked: `.output/chrome-mv3/`

- [ ] **Step 1: Run relevant and full automated gates**

```bash
pnpm exec vitest run src/lib/__tests__/zktls-capture.test.ts src/lib/__tests__/zktls-runtime.test.ts
pnpm test
pnpm run typecheck
pnpm exec biome check src/lib/zktls/capture.ts src/lib/__tests__/zktls-capture.test.ts
git diff --check HEAD^ HEAD
```

Expected: every command exits zero.

- [ ] **Step 2: Build the unpacked development extension**

First confirm that the signed-config, Verifier, public-key, and profile values
are already exported in the local shell. Do not print their contents:

```bash
test -n "$WXT_ZKTLS_API_ENDPOINT"
test -n "$WXT_ZKTLS_VERIFIER_ENDPOINT"
test -n "$WXT_ZKTLS_PUBLIC_KEYS"
test -n "$WXT_ZKTLS_VERIFIER_PROFILE_ID"
```

Then build the Beta extension explicitly:

```bash
WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
WXT_WEB_ENDPOINT=https://app.lhdaobeta.top \
WXT_ZKTLS_ENABLED=true \
pnpm run build
```

Confirm that the manifest grants only the Beta Lighthouse hosts and that the
compiled worker contains the Beta GraphQL endpoint:

```bash
node -e "const m=require('./.output/chrome-mv3/manifest.json'); if(!m.host_permissions.includes('https://service.lhdaobeta.top/*')||!m.host_permissions.includes('https://app.lhdaobeta.top/*')) process.exit(1)"
rg -F "https://service.lhdaobeta.top/graphql" .output/chrome-mv3
```

Do not substitute the default production build.

- [ ] **Step 3: Re-run the Nado browser proof**

Reload `/Users/kkruis/Desktop/worktrees/lhdao-extension-zktls-v4/.output/chrome-mv3`
in Chrome. On the logged-in Nado page, start a fresh proof and keep the page
open. Confirm that an authenticated poll with forbidden headers no longer ends
the capture session and that a later safe replay advances beyond the prior
`unsupported header` error.

Record the next actual stage: captured, prover started, verifier completed, or
the exact new failure. Do not call the E2E complete unless the backend reports
the proof result.
