# zkTLS Beta Popup Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show the current Beta zkTLS attempt, captured request and response, and exact redacted failure inside the Product Check popup.

**Architecture:** Store one bounded diagnostic attempt on the existing Product Experience session. The popup, background controller, content watcher, capture runtime, and offscreen proof worker append sanitized events through the existing extension message path; the popup renders the record from the existing controller-state response. Reuse the current Beta compile-time flag and zkTLS sanitizer, and add no server, database, dependency, or provider-specific logic.

**Tech Stack:** TypeScript, React 19, WXT, Chrome MV3, Vitest, Biome

---

### Task 1: Define and bound the diagnostic record

**Files:**
- Modify: `src/types/product-experience.ts`
- Modify: `src/lib/zktls/debug.ts`
- Modify: `src/lib/__tests__/zktls-debug.test.ts`

- [ ] **Step 1: Write failing diagnostic-record tests**

Add tests that expect public JSON to survive, credential values to disappear,
error name/message/stack to remain, event history to stop at 30 entries, and a
detail block larger than 65,536 serialized bytes to carry a truncation marker.

```ts
const attempt = appendProductZkTlsDiagnostic(
  createProductZkTlsDiagnostic('correlation-1', 100),
  {
    at: 101,
    stage: 'capture-failed',
    status: 'failed',
    error: Object.assign(new Error('socket closed for Bearer abc'), {
      code: 'PROVER_FAILED',
    }),
  },
  ['Bearer abc'],
)

expect(JSON.stringify(attempt)).not.toContain('Bearer abc')
expect(attempt.events[0]?.error).toMatchObject({
  name: 'Error',
  message: 'socket closed for [REDACTED]',
  code: 'PROVER_FAILED',
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run src/lib/__tests__/zktls-debug.test.ts
```

Expected: FAIL because the diagnostic types and bounded append functions do not
exist.

- [ ] **Step 3: Add the shared types and minimal append functions**

Add these plain-data types to `src/types/product-experience.ts`:

```ts
export interface ProductZkTlsDiagnosticEvent {
  at: number
  stage: string
  status: 'running' | 'passed' | 'failed'
  details?: unknown
  error?: unknown
}

export interface ProductZkTlsDiagnostic {
  correlationId: string
  startedAt: number
  updatedAt: number
  events: ProductZkTlsDiagnosticEvent[]
}
```

Export these functions from `src/lib/zktls/debug.ts`:

```ts
export function createProductZkTlsDiagnostic(
  correlationId: string,
  now: number,
): ProductZkTlsDiagnostic

export function appendProductZkTlsDiagnostic(
  current: ProductZkTlsDiagnostic,
  event: ProductZkTlsDiagnosticEvent,
  secretValues?: readonly string[],
): ProductZkTlsDiagnostic
```

Reuse `sanitize`. Copy enumerable error fields such as `code` in addition to
name, message, and stack. Bound the result to the last 30 events. Serialize each
details/error value once; when it exceeds 65,536 UTF-8 bytes, replace it with
`{ truncated: true, byteLength }` instead of retaining the oversized value.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 5: Commit the diagnostic model**

```bash
git add src/types/product-experience.ts src/lib/zktls/debug.ts \
  src/lib/__tests__/zktls-debug.test.ts
git commit -m "feat(zktls): model Beta popup diagnostics"
```

### Task 2: Trace click, injection, bootstrap, and rule evaluation

**Files:**
- Modify: `src/lib/product-experience-controller.ts`
- Modify: `src/lib/product-experience-rules.ts`
- Modify: `src/lib/product-experience-watcher.ts`
- Modify: `src/entrypoints/product-experience.content.ts`
- Modify: `src/entrypoints/background.ts`
- Modify: `src/types/messages.ts`
- Modify: `src/lib/__tests__/product-experience-controller.test.ts`
- Modify: `src/lib/__tests__/product-experience-rules.test.ts`
- Modify: `src/lib/__tests__/product-experience-watcher.test.ts`

- [ ] **Step 1: Write the failing pre-proof tests**

Cover these observable events in order:

```ts
expect(state.zkTlsDiagnostic?.events.map((event) => event.stage)).toEqual([
  'start-request-received',
  'page-watcher-injected',
  'watcher-bootstrapped',
  'watcher-ready',
])
```

For rule evaluation, assert exact safe details:

```ts
expect(onDiagnostic).toHaveBeenCalledWith({
  ruleId: 'rule-a',
  title: 'Deposit visible',
  selector: '[data-deposit-row]',
  urlMatched: true,
  matchedElementCount: 0,
  visibleElementCount: 0,
  conditionType: 'ELEMENT_EXISTS',
  conditionMatched: false,
})
```

Also test invalid selector, URL mismatch, matched evidence, disabled diagnostics,
wrong tab/frame/session sender, and retry replacing the previous attempt.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/product-experience-controller.test.ts \
  src/lib/__tests__/product-experience-rules.test.ts \
  src/lib/__tests__/product-experience-watcher.test.ts
```

Expected: FAIL because no diagnostic attempt, evaluation observer, or runtime
message exists.

- [ ] **Step 3: Add a non-authoritative evaluation observer**

Extend `ProductRuleEvaluationOptions`:

```ts
onDiagnostic?(result: ProductRuleEvaluationDiagnostic): void
```

Report rule ID, title, selector, URL match, selector validity, total and visible
element counts, condition type, and condition result. Call the observer through
`try/catch`; observer failure must not change `evaluateProductRule` output.
Do not include DOM text or attribute values.

- [ ] **Step 4: Forward rule events from the content script**

Add this exact request variant in `src/types/messages.ts`:

```ts
| {
    type: 'product-experience-diagnostic'
    sessionId: string
    event: ProductZkTlsDiagnosticEvent
  }
```

Wire the watcher observer to `chrome.runtime.sendMessage`. Emit
`watcher-bootstrapped` after a valid bootstrap, `watcher-ready` after the ready
ack, and `rule-evaluated` for each result. Ignore transport failure after
stopping the watcher.

- [ ] **Step 5: Store the current attempt on the existing session**

Add `zkTlsDiagnostic?: ProductZkTlsDiagnostic` to
`ProductExperienceSession` and `ProductExperienceControllerState`. Add
`diagnosticsEnabled: boolean` to controller dependencies and pass
`ZKTLS_PROFILE.debug` from `background.ts`.

At the start of every ZKTLS retry, replace the record:

```ts
session.zkTlsDiagnostic = createProductZkTlsDiagnostic(
  this.dependencies.randomSessionId(),
  this.dependencies.now(),
)
```

Append `start-request-received`, then append injection success or the exact
injection error. In `bootstrap`, `ready`, and the new `handleDiagnostic`, verify
the existing session and sender before appending. Use the existing serialized
zkTLS session mutation path so concurrent messages cannot overwrite events.

- [ ] **Step 6: Route the diagnostic message in the background**

Handle `product-experience-diagnostic` beside bootstrap/ready/evidence and
return the existing `product-experience-ack`. Pass the normalized sender into
the controller. Diagnostics remain inert when `ZKTLS_PROFILE.debug` is false.

- [ ] **Step 7: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 8: Commit pre-proof tracing**

```bash
git add src/lib/product-experience-controller.ts \
  src/lib/product-experience-rules.ts \
  src/lib/product-experience-watcher.ts \
  src/entrypoints/product-experience.content.ts \
  src/entrypoints/background.ts src/types/messages.ts \
  src/lib/__tests__/product-experience-controller.test.ts \
  src/lib/__tests__/product-experience-rules.test.ts \
  src/lib/__tests__/product-experience-watcher.test.ts
git commit -m "feat(zktls): trace Beta page triggers"
```

### Task 3: Forward capture and proof-worker diagnostics

**Files:**
- Modify: `src/lib/zktls/runtime.ts`
- Modify: `src/entrypoints/zktls-offscreen/main.ts`
- Modify: `src/entrypoints/zktls-offscreen/worker.ts`
- Modify: `src/entrypoints/background.ts`
- Modify: `src/lib/product-experience-controller.ts`
- Modify: `src/lib/__tests__/zktls.test.ts`
- Modify: `src/entrypoints/__tests__/zktls-offscreen-main.test.ts`
- Modify: `src/entrypoints/__tests__/background.test.ts`
- Modify: `src/lib/__tests__/product-experience-controller.test.ts`

- [ ] **Step 1: Write failing capture and worker tests**

Assert this flow reaches controller state in order:

```ts
expect(stages).toEqual([
  'evidence-received',
  'proof-session-created',
  'capture-started',
  'captured-request',
  'signed-config-checked',
  'verifier-session-registered',
  'proxy-request-sent',
  'tls-transcript-received',
  'strict-json-checked',
  'reveal-submitted',
  'completion-received',
])
```

Add failure cases for permission denial, capture timeout, malformed response,
WASM/setup failure, and Verifier disconnect. Each must retain the original
error name/message/stack and stage after redaction. Assert public request and
response JSON remain visible while Cookie, Authorization, token, MAC key, HMAC,
and wallet signature values never enter controller state.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/zktls.test.ts \
  src/entrypoints/__tests__/zktls-offscreen-main.test.ts \
  src/entrypoints/__tests__/background.test.ts \
  src/lib/__tests__/product-experience-controller.test.ts
```

Expected: FAIL because capture and worker traces stop in local console output.

- [ ] **Step 3: Report capture stages through the direct controller callback**

Extend internal `ZkTlsRunRequest` with an optional function:

```ts
onDiagnostic?(event: ProductZkTlsDiagnosticEvent): void
```

The controller supplies a callback that appends to the current attempt.
`proveCapturedRequest` reports capture start, captured request, and caught exact
errors through this callback. Sanitize before invoking the callback. External
page-originated proof requests cannot supply a function because their parser
continues to construct the request from plain message fields.

- [ ] **Step 4: Forward the existing worker trace**

Pass the controller correlation ID into the offscreen prove message. Configure
`createZkTlsDebugTrace.write` in `worker.ts` to post this shape in addition to
the final result:

```ts
{
  id: message.id,
  diagnostic: {
    sessionId: message.sessionId,
    connectorId: message.connectorId,
    correlationId: message.correlationId,
    payload,
  },
}
```

In `main.ts`, distinguish diagnostic messages from final results. Forward a
sanitized `product-experience-proof-diagnostic` runtime message without
settling the proof job. The background accepts it only from the extension's
exact offscreen document URL.

- [ ] **Step 5: Bind worker diagnostics to the active queue item**

Add a controller method that accepts proof session ID, connector ID,
correlation ID, and sanitized event. Append only when all values match the
current proving queue item and current diagnostic attempt. Reject stale,
cross-session, cross-connector, and post-retry messages.

- [ ] **Step 6: Run the focused tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 7: Commit proof tracing**

```bash
git add src/lib/zktls/runtime.ts \
  src/entrypoints/zktls-offscreen/main.ts \
  src/entrypoints/zktls-offscreen/worker.ts \
  src/entrypoints/background.ts \
  src/lib/product-experience-controller.ts \
  src/lib/__tests__/zktls.test.ts \
  src/entrypoints/__tests__/zktls-offscreen-main.test.ts \
  src/entrypoints/__tests__/background.test.ts \
  src/lib/__tests__/product-experience-controller.test.ts
git commit -m "feat(zktls): surface Beta proof traces"
```

### Task 4: Render and copy diagnostics in the popup

**Files:**
- Create: `src/components/product-experience/ProductExperienceDiagnostics.tsx`
- Create: `src/components/product-experience/ProductExperienceDiagnostics.test.tsx`
- Modify: `src/components/product-experience/ProductExperienceCard.tsx`
- Modify: `src/entrypoints/popup/App.test.tsx`

- [ ] **Step 1: Write failing popup behavior tests**

Cover these behaviors with rendered user interactions:

```ts
await user.click(screen.getByRole('button', { name: '继续证明' }))
expect(screen.getByText('正在检查页面')).toBeInTheDocument()
expect(screen.getByText('已收到点击')).toBeInTheDocument()
```

Assert a selector miss shows the exact selector and counts. Assert a failed
event automatically expands and shows exact code, name, message, stack, and
stage. Assert request/response blocks show public JSON and redacted credentials.
Mock `navigator.clipboard.writeText` and assert copied text equals the redacted
diagnostic JSON. Assert no panel renders when diagnostics are absent.

- [ ] **Step 2: Run the popup tests and verify RED**

Run:

```bash
./node_modules/.bin/vitest run \
  src/components/product-experience/ProductExperienceDiagnostics.test.tsx \
  src/entrypoints/popup/App.test.tsx
```

Expected: FAIL because the component and running feedback do not exist.

- [ ] **Step 3: Add the minimal timeline component**

Render one `<details>` block titled `验证过程`. Keep it open while an event is
running or failed. Render events in order with `…`, `✓`, or `✕`. Render details
inside `<pre>` using `JSON.stringify(value, null, 2)`. Use nested `<details>` for
`捕获的请求` and `捕获的响应`. Add one `复制诊断` button that writes the same
pretty-printed record to the clipboard.

Do not add tabs, filters, search, downloads, history, animations, or a separate
page.

- [ ] **Step 4: Integrate visible start feedback**

Pass `state.zkTlsDiagnostic` into the new component. While the start request is
in flight, render `正在检查页面` and keep the button disabled. Once the returned
state contains `start-request-received`, render the timeline even if the public
status remains `observing`.

- [ ] **Step 5: Run popup tests and verify GREEN**

Run the command from Step 2. Expected: all tests pass.

- [ ] **Step 6: Commit the popup UI**

```bash
git add src/components/product-experience/ProductExperienceDiagnostics.tsx \
  src/components/product-experience/ProductExperienceDiagnostics.test.tsx \
  src/components/product-experience/ProductExperienceCard.tsx \
  src/entrypoints/popup/App.test.tsx
git commit -m "feat(zktls): show Beta proof diagnostics"
```

### Task 5: Privacy regression and Beta package

**Files:**
- Modify: `src/lib/__tests__/product-experience-privacy.test.ts`
- Verify: all files changed by Tasks 1-4
- Build output: `.output/chrome-mv3/`

- [ ] **Step 1: Write the failing end-to-end privacy test**

Create a complete attempt containing public Nado-shaped JSON plus Cookie,
Authorization, Set-Cookie, plugin token, wallet signature, MAC key, and HMAC
values. Pass it through watcher, controller state, popup render, and copy
serialization. Assert the public response remains and each credential string is
absent at every boundary.

- [ ] **Step 2: Run the privacy test and verify RED or existing coverage**

Run:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/product-experience-privacy.test.ts
```

Expected: the new complete-flow case fails until every boundary uses the shared
sanitizer. If it passes immediately, remove duplicated assertions and retain the
smallest case that fails when sanitization is bypassed.

- [ ] **Step 3: Route every diagnostic boundary through the shared sanitizer**

Make the smallest corrections required by Step 2. Do not add a second redaction
list or UI-only masking helper.

- [ ] **Step 4: Run focused and full verification**

Run:

```bash
./node_modules/.bin/vitest run \
  src/lib/__tests__/zktls-debug.test.ts \
  src/lib/__tests__/product-experience-rules.test.ts \
  src/lib/__tests__/product-experience-watcher.test.ts \
  src/lib/__tests__/product-experience-controller.test.ts \
  src/lib/__tests__/product-experience-privacy.test.ts \
  src/lib/__tests__/zktls.test.ts \
  src/entrypoints/__tests__/zktls-offscreen-main.test.ts \
  src/entrypoints/__tests__/background.test.ts \
  src/components/product-experience/ProductExperienceDiagnostics.test.tsx \
  src/entrypoints/popup/App.test.tsx
./node_modules/.bin/vitest run
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/biome check \
  src/types/product-experience.ts \
  src/types/messages.ts \
  src/lib/zktls/debug.ts \
  src/lib/zktls/runtime.ts \
  src/lib/product-experience-rules.ts \
  src/lib/product-experience-watcher.ts \
  src/lib/product-experience-controller.ts \
  src/entrypoints/product-experience.content.ts \
  src/entrypoints/background.ts \
  src/entrypoints/zktls-offscreen/main.ts \
  src/entrypoints/zktls-offscreen/worker.ts \
  src/components/product-experience/ProductExperienceCard.tsx \
  src/components/product-experience/ProductExperienceDiagnostics.tsx
git diff --check
```

Expected: all tests, type-check, Biome, and diff checks pass.

- [ ] **Step 5: Build the Beta diagnostic package**

Require the same private shell variables used by the verified Beta build. Check
that they exist without printing their values:

```bash
test -n "$BETA_ZKTLS_API_ENDPOINT"
test -n "$BETA_ZKTLS_VERIFIER_ENDPOINT"
test -n "$BETA_ZKTLS_VERIFIER_PROFILE_ID"
test -n "$BETA_ZKTLS_PUBLIC_KEYS"
```

Then run:

```bash
WXT_ZKTLS_ENABLED=true \
WXT_ZKTLS_DEBUG=true \
WXT_API_ENDPOINT=https://service.lhdaobeta.top/graphql \
WXT_WEB_ENDPOINT=https://app.lhdaobeta.top \
WXT_ZKTLS_API_ENDPOINT="$BETA_ZKTLS_API_ENDPOINT" \
WXT_ZKTLS_VERIFIER_ENDPOINT="$BETA_ZKTLS_VERIFIER_ENDPOINT" \
WXT_ZKTLS_VERIFIER_PROFILE_ID="$BETA_ZKTLS_VERIFIER_PROFILE_ID" \
WXT_ZKTLS_PUBLIC_KEYS="$BETA_ZKTLS_PUBLIC_KEYS" \
pnpm run build
```

Expected: Chrome MV3 build succeeds at `.output/chrome-mv3/`. Read the generated
profile and assert `enabled: true`, `debug: true`, and the Beta API origin before
handing the folder to the user. Do not substitute production endpoints or keys.

- [ ] **Step 6: Commit final privacy coverage**

```bash
git add src/lib/__tests__/product-experience-privacy.test.ts
git commit -m "test(zktls): protect popup diagnostics"
```

- [ ] **Step 7: Read back the finished range**

```bash
git status --short
git log --oneline e50ff5a..HEAD
git diff --check e50ff5a..HEAD
```

Expected: worktree clean, diagnostic commits present, and range diff clean. Do
not push or deploy without a separate user request.
