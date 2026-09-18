# Plugin Device Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover safely from `PLUGIN_DEVICE_DENIED` by offering explicit one-click re-pairing in the popup and promotion dialog.

**Architecture:** Add one pure error classifier shared by both interfaces. Reuse the existing `start-pairing` background message and pairing state machine; the background worker keeps the old token until polling returns a new device-bound token. Do not change backend authorization or retry spending mutations.

**Tech Stack:** TypeScript, React 19, WXT, Chrome extension messaging, Vitest, Biome

---

### Task 1: Classify device authorization failures

**Files:**
- Create: `src/lib/plugin-device-recovery.ts`
- Create: `src/lib/__tests__/plugin-device-recovery.test.ts`

- [ ] **Step 1: Write the failing classifier test**

```ts
import { describe, expect, it } from 'vitest'
import { isPluginDeviceDenied } from '../plugin-device-recovery'

describe('plugin device recovery', () => {
  it.each([
    'PLUGIN_DEVICE_DENIED: 您没有权限执行此操作。',
    '[HTTP 200] PLUGIN_DEVICE_DENIED: 您没有权限执行此操作。',
  ])('recognizes a device denial in %s', (message) => {
    expect(isPluginDeviceDenied(message)).toBe(true)
  })

  it('ignores unrelated plugin errors', () => {
    expect(isPluginDeviceDenied('PLUGIN_OPERATION_DENIED')).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/plugin-device-recovery.test.ts
```

Expected: FAIL because `../plugin-device-recovery` does not exist.

- [ ] **Step 3: Add the minimal classifier**

```ts
const PLUGIN_DEVICE_DENIED = 'PLUGIN_DEVICE_DENIED'

export function isPluginDeviceDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return message.includes(PLUGIN_DEVICE_DENIED)
}
```

- [ ] **Step 4: Run the test and verify GREEN**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/plugin-device-recovery.test.ts
```

Expected: 3 tests pass.

### Task 2: Add popup re-pairing

**Files:**
- Modify: `src/entrypoints/popup/App.tsx`
- Test: `src/lib/__tests__/plugin-device-recovery.test.ts`

- [ ] **Step 1: Route the existing pairing callbacks into the connected error banner**

Import `isPluginDeviceDenied`, then pass `pairing`, `startPair`, and
`cancelPair` through `ConnectedBlock` to `SyncErrorBanner`:

```tsx
<ConnectedBlock
  data={data}
  syncing={syncing}
  pairing={pairing}
  onForceSync={forceSync}
  onReconnect={startPair}
  onCancelReconnect={cancelPair}
  onOpenOptions={openOptions}
  onOpenWeb={openWeb}
/>
```

- [ ] **Step 2: Give the device error a recovery action**

Extend the diagnosis type and place this branch before the general HTTP status
branches:

```ts
interface SyncDiagnosis {
  title: string
  hint: string
  action?: 'reconfigure' | 'reconnect'
}

if (isPluginDeviceDenied(err)) {
  return {
    title: '设备授权已失效',
    hint: '此 Token 未绑定当前浏览器，请重新连接。',
    action: 'reconnect',
  }
}
```

- [ ] **Step 3: Render the reconnect action**

Pass `pairing`, `onReconnect`, and `onCancelReconnect` into
`SyncErrorBanner`. Render a button only when `action === 'reconnect'`:

```tsx
{action === 'reconnect' && (
  <button
    type="button"
    disabled={pairing.kind === 'success'}
    onClick={
      pairing.kind === 'waiting' ? onCancelReconnect : onReconnect
    }
    className="mt-1.5 text-[10.5px] font-bold text-rose-700 hover:underline disabled:opacity-60 dark:text-rose-300"
  >
    {pairing.kind === 'waiting'
      ? '取消重新连接'
      : pairing.kind === 'success'
        ? '已重新连接，正在同步…'
        : '重新连接 →'}
  </button>
)}
```

- [ ] **Step 4: Verify the focused tests and type contract**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/plugin-device-recovery.test.ts src/lib/__tests__/pairing-query.test.ts
pnpm run compile
pnpm run typecheck
```

Expected: focused tests pass, WXT types generate, and TypeScript exits 0.

### Task 3: Add promotion-dialog recovery without automatic retry

**Files:**
- Modify: `src/components/promote/PromoteDialog.tsx`
- Test: `src/lib/__tests__/plugin-device-recovery.test.ts`

- [ ] **Step 1: Detect device denial and track reconnect startup**

Import `isPluginDeviceDenied`, add `reconnecting` state, and derive
`deviceDenied` from the current error:

```tsx
const [reconnecting, setReconnecting] = React.useState(false)
const deviceDenied = phase === 'error' && isPluginDeviceDenied(errMsg)
```

- [ ] **Step 2: Start the existing pairing flow from the dialog**

```tsx
const reconnect = async () => {
  setReconnecting(true)
  try {
    const result = await sendMessage({ type: 'start-pairing' })
    if (result.type === 'pairing-started' && !result.ok) {
      setErrMsg(result.reason)
    }
  } finally {
    setReconnecting(false)
  }
}
```

- [ ] **Step 3: Replace the raw error and prevent repeated spending attempts**

```tsx
{phase === 'error' && (
  <div className="lh-warn">
    {deviceDenied
      ? '设备授权已失效，请重新连接后再推广。'
      : errMsg}
  </div>
)}
{deviceDenied && (
  <button
    type="button"
    className="lh-reconnect"
    disabled={reconnecting}
    onClick={reconnect}
  >
    {reconnecting ? '正在打开授权页面…' : '重新连接'}
  </button>
)}
```

Also disable the original submit button while `deviceDenied` is true. Add a
small `.lh-reconnect` rule beside `.lh-primary`; do not add a new dependency or
component abstraction.

- [ ] **Step 4: Run focused verification**

Run:

```bash
pnpm exec vitest run src/lib/__tests__/plugin-device-recovery.test.ts src/lib/__tests__/pairing-query.test.ts
pnpm run typecheck
```

Expected: focused tests pass and TypeScript exits 0.

### Task 4: Full verification and review

**Files:**
- Review: `src/lib/plugin-device-recovery.ts`
- Review: `src/lib/__tests__/plugin-device-recovery.test.ts`
- Review: `src/entrypoints/popup/App.tsx`
- Review: `src/components/promote/PromoteDialog.tsx`

- [ ] **Step 1: Format only the touched files**

Run:

```bash
pnpm exec biome format --write src/lib/plugin-device-recovery.ts src/lib/__tests__/plugin-device-recovery.test.ts src/entrypoints/popup/App.tsx src/components/promote/PromoteDialog.tsx
```

- [ ] **Step 2: Run the full test suite**

Run:

```bash
pnpm run test
```

Expected: all Vitest files and tests pass.

- [ ] **Step 3: Run compile, type checking, lint, and build**

Run:

```bash
pnpm run compile
pnpm run typecheck
pnpm exec biome check src/lib/plugin-device-recovery.ts src/lib/__tests__/plugin-device-recovery.test.ts src/entrypoints/popup/App.tsx src/components/promote/PromoteDialog.tsx
pnpm run build
```

Expected: every command exits 0.

- [ ] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git diff -- src/lib/plugin-device-recovery.ts src/lib/__tests__/plugin-device-recovery.test.ts src/entrypoints/popup/App.tsx src/components/promote/PromoteDialog.tsx
```

Confirm that the diff contains no backend authorization change, no automatic
promotion retry, and no local-token deletion before pairing success.

The implementation must remain uncommitted because the two modified UI files
already contain user-owned, uncommitted feature work that depends on other
untracked security files. Committing these files alone would create an invalid
partial commit.

